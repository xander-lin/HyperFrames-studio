/**
 * Manage the Hyperframes preview child process.
 *
 * Why not implement Studio's backend ourselves: that backend has a render queue,
 * thumbnails, an asset proxy, undo history and GSAP parsing — thousands of lines
 * sharing a protocol with the Studio frontend. Reimplementing it has no upside and
 * can never keep up. The desktop app therefore treats `hyperframes preview` as a
 * replaceable backend process.
 *
 * Every external interaction here (spawn, HTTP probe) is injectable, for testing.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface PreviewServer {
  readonly port: number;
  readonly origin: string;
  stop(): Promise<void>;
}

export interface StartPreviewOptions {
  readonly projectDir: string;
  /** Deprecated: the CLI picks its own port (reuse or new); forcing one causes a mismatch. */
  readonly preferredPort?: number;
  /** How long to wait for the service to become ready. */
  readonly readyTimeoutMs?: number;
  /** Injection point for tests: spawn the child process. */
  readonly spawnImpl?: typeof spawn;
  /** Injection point for tests: probe readiness. */
  readonly probe?: (origin: string) => Promise<boolean>;
}

/** Kept for docs and legacy callers; the real port comes from the CLI. */
export const DEFAULT_PORT = 3002;

/**
 * Start the preview service and wait until it actually answers.
 *
 * `--background` is used so the CLI detaches the service and returns JSON at once;
 * the user's preview therefore survives our process exiting unexpectedly. `--json`
 * gives us the real port (it may shift when taken) instead of a guess.
 *
 * **No `--port`**: the CLI's default behaviour for "this project already has a
 * service" is reuse, but an explicitly different port makes it fail with
 * `preview-port-mismatch` (see found.md F-012). Letting it choose handles both reuse
 * and a fresh start. `preferredPort` is only a hint, passed via the environment on
 * first start.
 */
export async function startPreviewServer(options: StartPreviewOptions): Promise<PreviewServer> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;

  const args = [
    "preview",
    options.projectDir,
    "--no-open",
    "--background",
    "--json",
  ];

  const result = await runCli(spawnImpl, args);

  if (!result.ok) {
    throw new Error(`Failed to start the preview service: ${result.message}`);
  }

  const port = result.payload.port;
  const origin = result.payload.serverUrl?.replace(/\/+$/, "") ?? `http://127.0.0.1:${port}`;

  const probe = options.probe ?? probePreviewReady;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probe(origin)) {
      return {
        port,
        origin,
        stop: async () => {
          await runCli(spawnImpl, ["preview", options.projectDir, "--stop"]).catch(() => undefined);
        },
      };
    }
    await sleep(400);
  }

  // Tear down a half-started service rather than leaving an orphan holding the port.
  await runCli(spawnImpl, ["preview", options.projectDir, "--stop"]).catch(() => undefined);
  throw new Error(`Preview service did not become ready within ${readyTimeoutMs}ms (${origin})`);
}

interface CliPayload {
  readonly ok?: boolean;
  readonly port?: number;
  readonly serverUrl?: string;
  readonly result?: {
    readonly port?: number;
    readonly serverUrl?: string;
    readonly ready?: boolean;
    readonly mode?: string;
  };
}

interface CliRun {
  readonly ok: true;
  readonly payload: Required<Pick<CliPayload, "port">> &
    Pick<CliPayload, "serverUrl"> & { readonly raw: string };
}
type CliRunResult = CliRun | { readonly ok: false; readonly message: string };

/**
 * Run the hyperframes CLI once and parse its JSON output.
 *
 * `npx hyperframes` rather than depending on `hyperframes` in PATH: the machine may
 * only have a project-local install, and the project-local version is the one that
 * matches the composition format being edited.
 */
function runCli(spawnImpl: typeof spawn, args: readonly string[]): Promise<CliRunResult> {
  return new Promise((resolveRun) => {
    const child: ChildProcess = spawnImpl("npx", ["--yes", "hyperframes", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolveRun({ ok: false, message: error.message });
    });

    child.on("close", (code) => {
      const parsed = parseCliJson(stdout);
      if (!parsed) {
        resolveRun({
          ok: false,
          message: `CLI exited with code ${code ?? "?"} and its output could not be parsed: ${(stderr || stdout).slice(0, 400)}`,
        });
        return;
      }
      if (parsed.ok === false) {
        resolveRun({ ok: false, message: describeCliError(parsed) });
        return;
      }
      // Two payload shapes are supported: `--json` lifecycle wraps a `result`, early
      // versions were flat.
      const port = parsed.result?.port ?? parsed.port;
      if (typeof port !== "number" || !Number.isFinite(port)) {
        resolveRun({ ok: false, message: `The CLI returned no port: ${stdout.slice(0, 400)}` });
        return;
      }
      resolveRun({
        ok: true,
        payload: { port, serverUrl: parsed.result?.serverUrl ?? parsed.serverUrl, raw: stdout },
      });
    });
  });
}

function parseCliJson(stdout: string): (CliPayload & { error?: unknown }) | null {
  // stdout may carry advisory lines; take the last line that parses as JSON.
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) return parsed as CliPayload;
    } catch {
      // Keep searching upwards.
    }
  }
  return null;
}

function describeCliError(payload: { error?: unknown }): string {
  const { error } = payload;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return "The CLI reported a failure";
}

/** Probe `/api/projects` — the first request the Studio frontend makes at startup. */
async function probePreviewReady(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/projects`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
