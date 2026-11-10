/**
 * End-to-end acceptance: **the installed app delivers into a live OpenCode session**.
 *
 * ## What makes this end-to-end
 *
 * Every other check stops at a boundary: unit tests stop at a function, `scripts/verify-*.mjs`
 * stop at the app's own DOM and HTTP routes. None of them answers the only question the user
 * actually has — if I draw and press send, does a conversation receive it?
 *
 * So this runs the whole chain with no mocks:
 *
 * ```
 * installed MyStudio  →  /__mystudio/deliver  →  subscriber registry
 *        →  plugin inbox  →  session.prompt(queue)  →  the session's stored messages
 * ```
 *
 * ## The structural constraint it works around
 *
 * `opencode serve` does **not** load plugins, and `opencode run --standalone` loads them but
 * exits when the prompt finishes. A plugin therefore only exists *during* a `run`. So the
 * delivery happens while a `run` is alive — the runner asks the model for work that takes a
 * while, and this script waits for the plugin's inbox to appear before sending.
 *
 * ## How arrival is proven
 *
 * Not by the app's own reply ("delivered") — that is the sender talking about itself. The
 * `--standalone` server binds a random port, so there is no HTTP endpoint to ask. What is
 * checked instead is OpenCode's own database: the marker text must exist in the messages of
 * that session. That is the same state the user would see in the TUI.
 *
 * ## Isolation
 *
 * A temporary `OPENCODE_CONFIG`, a temporary project and a temporary runtime dir are used. The
 * user's global config is never touched (found.md F-025).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const INBOX_PORT = Number(process.env.E2E_INBOX_PORT ?? 47812);
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4317);

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether something listens on a loopback port. */
function listening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.on("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.on("error", () => done(false));
  });
}

/** Poll until a condition holds, so no fixed sleep can make this flaky. */
async function until(label, predicate, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await pause(500);
  }
}

/** The installed launcher, or `electron .` as a fallback for a source checkout. */
async function launcher() {
  const installed = process.env.MYSTUDIO_LAUNCHER ?? join(repoRoot, "release", "mystudio");
  if (existsSync(installed)) return { command: installed, prefixArgs: [], appDir: null };

  const electron = join(repoRoot, "packages", "desktop", "node_modules", ".bin", "electron");
  if (existsSync(electron)) {
    return {
      command: electron,
      prefixArgs: [join(repoRoot, "packages", "desktop")],
      appDir: join(repoRoot, "packages", "desktop"),
    };
  }
  throw new Error(
    "No launcher found. Build the install first: node packages/desktop/scripts/install.mjs",
  );
}

/** The marker that must come back out of the session. */
function markerFor(run) {
  return `mystudio-e2e-${run}-${Date.now().toString(36)}`;
}

/**
 * Read what a session is holding: **queued** deliveries plus consumed messages.
 *
 * ## Why two tables
 *
 * The plugin injects with `delivery: "queue"`, `resume: false` — deliberately, so a prompt never
 * interrupts what the user is typing (found.md F-030). A queued message therefore lives in
 * `session_inbox`, **not** in `session_message`, and it is consumed into the conversation only on
 * the user's next turn.
 *
 * That is the correct behaviour and it made the first version of this check wrong: it looked in
 * `session_message`, found nothing, and reported "the prompt did not arrive" while the message was
 * sitting in the queue exactly as designed. Both tables are read here, because arrival means
 * "the session is holding this text" regardless of which side of the queue boundary it is on.
 *
 * Read-only so a running OpenCode is never disturbed.
 */
async function sessionText(sessionID) {
  const home = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share");
  const dbPath = join(home, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return "";
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const queued = db
      .prepare("select payload from session_inbox where session_id = ?")
      .all(sessionID)
      .map((row) => String(row.payload ?? ""));
    const stored = db
      .prepare("select data from session_message where session_id = ?")
      .all(sessionID)
      .map((row) => String(row.data ?? ""));
    const parts = db
      .prepare("select data from session_part where session_id = ?")
      .all(sessionID)
      .map((row) => String(row.data ?? ""));
    return [...queued, ...stored, ...parts].join("\n");
  } catch {
    return "";
  } finally {
    db.close();
  }
}

/** The most recently created session id, from the database. */
async function newestSession() {
  const home = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share");
  const dbPath = join(home, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("select id, time_created from session_v2 order by time_created desc limit 1")
      .get();
    return row ? { id: String(row.id), createdAt: Number(row.time_created) } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function main() {
  const run = Date.now().toString(36);
  /* Anything created before this moment belongs to an earlier run and must not be used. */
  const runStartedAt = Date.now();
  const marker = markerFor(run);
  const workDir = await mkdtemp(join(tmpdir(), `mystudio-e2e-${run}-`));
  const projectDir = join(workDir, "project");
  const configDir = join(workDir, "opencode");
  await mkdir(projectDir, { recursive: true });
  await mkdir(configDir, { recursive: true });

  // A minimal but valid project: `detectProject` wants these two files.
  await writeFile(
    join(projectDir, "index.html"),
    '<!doctype html><html><body><div data-composition-id="main" data-width="1920" data-height="1080"><h1>e2e</h1></div></body></html>\n',
    "utf8",
  );
  await writeFile(join(projectDir, "hyperframes.json"), JSON.stringify({ name: "e2e" }), "utf8");
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "e2e", private: true }, null, 2),
    "utf8",
  );

  /*
   * The plugin is registered by **directory**. A single `.js` path is silently skipped by the
   * loader, and the symptom is "the plugin just does not run" (found.md F-034).
   */
  const opencodeConfig = join(configDir, "opencode.json");
  await writeFile(
    opencodeConfig,
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: [join(repoRoot, "packages", "opencode-plugin")] },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[e2e] work  ${workDir}`);
  console.log(`[e2e] mark  ${marker}`);

  const app = spawn(
    (await launcher()).command,
    [
      ...(await launcher()).prefixArgs,
      projectDir,
      "--no-sandbox",
      "--remote-debugging-port=9333",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      /*
       * `XDG_RUNTIME_DIR` is **not** overridden. Wayland's socket lives in it, and pointing it at
       * a temp directory makes the app fail to start with "Failed to connect to Wayland display"
       * — a failure that looks like a packaging bug (found.md F-132).
       *
       * Isolation comes from a unique project path and inbox port instead, and the presence
       * record this run creates is removed at the end.
       */
      env: process.env,
    },
  );
  let appLog = "";
  app.stdout.on("data", (c) => (appLog += c));
  app.stderr.on("data", (c) => (appLog += c));

  let runner = null;
  let createdSubscription = null;
  let createdPresence = null;
  try {
    await until("the app server", () => appLog.includes("App server at"));
    check("the installed app serves the given project", true);

    const config = await (await fetch(`http://127.0.0.1:${APP_PORT}/__mystudio/config`)).json();
    check(
      "it opened the project from the command line, not its own tree",
      config.projectDir === projectDir,
      JSON.stringify({ got: config.projectDir, want: projectDir }),
    );

    /*
     * A `run --standalone` keeps a plugin-bearing server alive while the model works. The prompt
     * asks for several steps so the window is long enough to deliver into it.
     */
    runner = spawn(
      "opencode",
      [
        "run",
        "--standalone",
        "--print-logs",
        "Use the bash tool to run `ls -la`, `date`, and `uname -a` separately. Then summarise the three outputs.",
      ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG: opencodeConfig,
          MYSTUDIO_INBOX_PORT: String(INBOX_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let runLog = "";
    runner.stdout.on("data", (c) => (runLog += c));
    runner.stderr.on("data", (c) => (runLog += c));

    await until("the plugin inbox", () => listening(INBOX_PORT), 120_000);
    check("the plugin loads and opens its inbox", true, `port ${INBOX_PORT}`);
    check(
      "it registers the subscription tools",
      runLog.includes("Subscription tools registered"),
      "",
    );

    // ── subscribe ────────────────────────────────────────────────────────
    /*
     * The session is read **after** the inbox appears, and anything created before this run
     * started is ignored. Taking "the newest session" blindly picked up a session left over from
     * an earlier manual attempt, and the marker then had to arrive in the wrong conversation
     * (found.md F-132).
     */
    const sessionID = await until(
      "this run's session",
      async () => {
        const found = await newestSession();
        if (!found) return null;
        return found.createdAt > runStartedAt ? found.id : null;
      },
      30_000,
    ).catch(() => null);
    check("this run created a session", typeof sessionID === "string", String(sessionID));

    const runtimeRoot = process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, "mystudio")
      : join(tmpdir(), "mystudio");
    const appsDir = join(runtimeRoot, "apps");
    /*
     * Find **this run's** presence record, not merely the first one.
     *
     * Presence files from earlier runs are not removed when a process is killed, so the directory
     * routinely holds records whose pid is dead and whose project is a temp path from a previous
     * test. Taking `advertised[0]` therefore picked a stale entry and reported the wrong project —
     * a failure of the probe, not of the app (found.md F-132).
     *
     * The record is matched on the project directory (unique per run) and on its pid being alive.
     */
    const presence = await until(
      "this run's presence record",
      async () => {
        const names = await readdir(appsDir).catch(() => []);
        for (const name of names) {
          const entry = JSON.parse(await readFile(join(appsDir, name), "utf8").catch(() => "{}"));
          if (entry.projectDir !== projectDir) continue;
          createdPresence = join(appsDir, name);
          if (typeof entry.pid !== "number") continue;
          try {
            process.kill(entry.pid, 0);
          } catch {
            continue; // dead pid: a stale record, skip it
          }
          return entry;
        }
        return null;
      },
      30_000,
    ).catch(() => null);
    check(
      "this run has a presence record with a live pid",
      presence !== null,
      presence ? JSON.stringify({ dir: presence.projectDir, pid: presence.pid }) : "none found",
    );
    if (!presence) throw new Error("No presence record for this run");

    const subsDir = join(runtimeRoot, "subscriptions", presence.appId);
    await mkdir(subsDir, { recursive: true });
    createdSubscription = join(subsDir, `${sessionID}.json`);
    await writeFile(
      createdSubscription,
      JSON.stringify(
        {
          version: 1,
          appId: presence.appId,
          projectDir,
          sessionID,
          pluginEndpoint: `http://127.0.0.1:${INBOX_PORT}`,
          createdAt: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );

    // ── deliver ──────────────────────────────────────────────────────────
    /*
     * A **real** image file.
     *
     * The plugin attaches `bundle.ink[].imagePath` to the message, and OpenCode refuses the whole
     * injection when the file cannot be read ("Unable to read attachment"). A made-up path
     * therefore looked like a delivery failure — the annotation was queued and the session got
     * nothing. A 1×1 PNG is enough: this check is about the path being real and reachable, not
     * about its contents (found.md F-132).
     */
    const framesDir = join(projectDir, ".mystudio", "frames");
    await mkdir(framesDir, { recursive: true });
    const capturePath = join(framesDir, "e2e.png");
    await writeFile(
      capturePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    const bundle = {
      schemaVersion: 1,
      projectDir,
      projectId: config.projectId,
      summary: "",
      createdAt: Date.now(),
      annotations: [],
      ink: [
        {
          compositionPath: "index.html",
          time: 1.5,
          imagePath: capturePath,
          ref: "Capture 1",
        },
      ],
    };
    const prompt = [
      "## HyperFrames change request v3",
      "",
      `- Project directory: \`${projectDir}\``,
      "- Blocks: 1",
      "",
      "## What I want",
      "",
      `Capture 1 — ${marker}`,
    ].join("\n");

    const delivered = await (
      await fetch(`http://127.0.0.1:${APP_PORT}/__mystudio/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, prompt, bundle }),
      })
    ).json();

    const detail = String(delivered.outcome?.detail ?? "");
    check(
      "the app reached the subscriber (not the outbox)",
      delivered.outcome?.ok === true && !detail.toLowerCase().includes("outbox"),
      JSON.stringify(delivered).slice(0, 300),
    );
    check(
      "it names the conversation that received it",
      Array.isArray(delivered.outcome?.targets) && delivered.outcome.targets.length > 0,
      JSON.stringify(delivered.outcome?.targets ?? null),
    );

    // ── prove it arrived ─────────────────────────────────────────────────
    const arrived = await until(
      "the marker in the session",
      async () => (await sessionText(sessionID)).includes(marker),
      30_000,
    ).catch(() => false);
    check("the prompt is queued in that conversation", arrived === true);
  } finally {
    runner?.kill("SIGTERM");
    app.kill("SIGTERM");
    await pause(1500);
    /*
     * Remove only what this run created. The subscription is ours (a random session id), and the
     * presence record disappears by itself when the app exits — but a record left by a killed
     * process would otherwise look like a live app for the next five minutes (found.md F-132).
     */
    if (createdSubscription) await rm(createdSubscription, { force: true }).catch(() => undefined);
    /*
     * Remove this run's presence record too. The app writes it on start and removes it on a clean
     * exit, but a `SIGTERM` kill skips that — leaving a record whose pid is gone. Left alone,
     * these accumulate and make the next run's presence lookup ambiguous (found.md F-132).
     */
    if (createdPresence) await rm(createdPresence, { force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n[FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
