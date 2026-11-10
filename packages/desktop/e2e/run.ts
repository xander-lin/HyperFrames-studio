/**
 * End-to-end acceptance script.
 *
 * It exercises the **real pipeline**, not a mock: it really starts the app server,
 * really requests the preview frame-capture endpoint and really delivers the prompt
 * to the OpenCode plugin. A standalone script rather than a unit test because the
 * correctness of these steps depends on "two processes, two ports, one cross-process
 * delivery" — mocking any link hides the problem entirely (which is exactly how
 * found.md F-014 was missed).
 *
 * Usage (a temp project and its preview service must already be running):
 *
 *   cd /tmp/opencode/mystudio-e2e && npx hyperframes preview . --no-open --background --json
 *   cd packages/desktop && pnpm e2e
 *
 * Environment overrides: E2E_PROJECT / E2E_PREVIEW / E2E_INBOX / E2E_APP_PORT /
 * E2E_STUDIO. Only temp projects under `/tmp` are allowed — never point this at the
 * real project the user is editing (found.md F-016).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBundle } from "@mystudio/protocol";
import { resolveSink } from "@mystudio/protocol/node";
import { startAppServer } from "../src/appServer.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const PROJECT = process.env.E2E_PROJECT ?? "/tmp/opencode/mystudio-e2e";
const PREVIEW = process.env.E2E_PREVIEW ?? "http://127.0.0.1:3002";
const INBOX = process.env.E2E_INBOX ?? "http://127.0.0.1:47899";
const PORT = Number(process.env.E2E_APP_PORT ?? 4640);
const STUDIO_DIR = process.env.E2E_STUDIO ?? join(packageRoot, "dist", "studio");
const PROJECT_ID = "mystudio-e2e";

/**
 * Send a **byte-for-byte** HTTP request, bypassing client-side URL normalisation.
 *
 * The only reliable way to test directory traversal: fetch / URL fold `..` and
 * `%2e%2e` away before they ever reach the server's path parsing.
 */
function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolveText, rejectText) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(requestText);
    });
    let buffer = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolveText(buffer);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("end", () => resolveText(buffer));
    socket.on("error", rejectText);
  });
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
}

/** The temp project is our own sandbox; pointing elsewhere would pollute user data, so refuse. */
function assertSandbox(dir: string): void {
  const absolute = resolve(dir);
  if (!absolute.startsWith("/tmp/")) {
    throw new Error(
      `Refusing to run end-to-end tests outside /tmp: ${absolute}. This protects your real projects (see found.md F-016).`,
    );
  }
}

async function assertProject(dir: string): Promise<void> {
  for (const name of ["index.html", "hyperframes.json"]) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`${dir} is missing ${name}; prepare a temporary Hyperframes project first`);
    }
  }
}

/** Probe whether the preview service is up; if not, print a ready-to-paste start command. */
async function assertPreview(origin: string): Promise<void> {
  try {
    const response = await fetch(`${origin}/api/projects`, { signal: AbortSignal.timeout(3_000) });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `Preview service unreachable (${origin}): ${error instanceof Error ? error.message : String(error)}\n` +
        `Start it first: cd ${PROJECT} && npx hyperframes preview . --no-open --background --json`,
    );
  }
}

async function main(): Promise<number> {
  assertSandbox(PROJECT);
  await assertProject(PROJECT);
  await assertPreview(PREVIEW);
  await mkdir(join(PROJECT, ".mystudio", "frames"), { recursive: true });
  await rm(join(PROJECT, ".mystudio", "outbox"), { recursive: true, force: true });

  const server = await startAppServer(
    {
      studioDir: STUDIO_DIR,
      previewOrigin: PREVIEW,
      config: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        projectName: PROJECT_ID,
        projectDir: PROJECT,
        inboxEndpoint: INBOX,
        previewOrigin: PREVIEW,
      },
      sink: resolveSink({ inboxEndpoint: INBOX, outboxDir: join(PROJECT, ".mystudio", "outbox") }),
      framesDir: join(PROJECT, ".mystudio", "frames"),
    },
    PORT,
  );

  console.log(`app server: ${server.url}`);

  try {
    // ── Static hosting and the bridge ─────────────────────────────────────
    const index = await fetch(`${server.url}/`);
    check("Serves the Studio build", index.status === 200, `HTTP ${index.status}`);

    const config = (await (await fetch(`${server.url}/__mystudio/config`)).json()) as {
      projectId?: string;
      projectDir?: string;
    };
    check(
      "Host config is served",
      config.projectId === PROJECT_ID && config.projectDir === PROJECT,
      JSON.stringify(config),
    );

    // ── Same-origin proxy: all of Studio's backend depends on it ───────────
    const projects = await fetch(`${server.url}/api/projects`);
    check("API proxy works", projects.status === 200, `HTTP ${projects.status}`);

    // ── Frame capture: the same same-origin relative path studio-shell uses ──
    const framePath =
      `/api/projects/${PROJECT_ID}/thumbnail/index.html` +
      `?t=2.500&format=png&output=source&v=${Date.now()}`;
    const thumb = await fetch(server.url + framePath);
    const png = Buffer.from(await thumb.arrayBuffer());
    const isPng = png.subarray(0, 4).toString("hex") === "89504e47";
    check(
      "Frame capture returns a PNG",
      thumb.status === 200 && isPng && png.length > 1_000,
      `${png.length}b ${thumb.headers.get("content-type")}`,
    );

    // ── Frame-saving endpoint ─────────────────────────────────────────────
    const frameName = "e2e_frame_A";
    const saved = (await (
      await fetch(`${server.url}/__mystudio/frame`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          annotationId: frameName,
          pngBase64: png.toString("base64"),
        }),
      })
    ).json()) as { ok: boolean; path?: string };
    const framePathOnDisk = join(PROJECT, ".mystudio", "frames", `${frameName}.png`);
    const written = await stat(framePathOnDisk).catch(() => null);
    check("Frame is written to disk", saved.ok === true && (written?.size ?? 0) > 1_000, saved.path ?? "no path");

    // ── Prompt rendering ──────────────────────────────────────────────────
    const bundle = {
      schemaVersion: 1 as const,
      projectDir: PROJECT,
      projectId: PROJECT_ID,
      summary: "the pacing is too fast and the frame feels crowded",
      annotations: [
        {
          id: "E2E_region",
          shape: {
            kind: "region" as const,
            rect: { x: 0.08, y: 0.16, width: 0.42, height: 0.22 },
          },
          frame: {
            compositionPath: "index.html",
            time: 2.5,
            compositionWidth: 1280,
            compositionHeight: 720,
          },
          note: "darken this area a little",
          frameImagePath: framePathOnDisk,
          createdAt: Date.now(),
        },
        {
          id: "E2E_arrow",
          shape: {
            kind: "arrow" as const,
            from: { x: 0.14, y: 0.23 },
            to: { x: 0.62, y: 0.66 },
          },
          frame: {
            compositionPath: "index.html",
            time: 2.5,
            compositionWidth: 1280,
            compositionHeight: 720,
          },
          note: "move the subtitle to the lower right",
          element: {
            hfId: "hf-sub01",
            id: "sub",
            tagName: "p",
            selector: "#sub",
            text: "annotation pipeline",
            box: { x: 0.095, y: 0.347, width: 0.22, height: 0.045 },
          },
          createdAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
    };
    const prompt = renderBundle(bundle);
    check("Prompt carries the timecode", prompt.includes("00:02.500"));
    check("Prompt carries the element identity", prompt.includes('hf-id="hf-sub01"') && prompt.includes("#sub"));
    check("Prompt carries the capture path", prompt.includes(`${frameName}.png`));
    check("Prompt carries the overview", prompt.includes("the pacing is too fast"));

    // ── Delivery ──────────────────────────────────────────────────────────
    const delivered = (await (
      await fetch(`${server.url}/__mystudio/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, prompt, bundle }),
      })
    ).json()) as {
      outcome: { ok: boolean; code?: string; detail?: string };
      sink: string | null;
    };
    check(
      "Delivery succeeds",
      delivered.outcome.ok === true,
      `${delivered.sink} :: ${delivered.outcome.detail ?? delivered.outcome.code ?? ""}`,
    );

    // ── Rejecting invalid input ───────────────────────────────────────────
    const empty = await fetch(`${server.url}/__mystudio/deliver`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, prompt: "x", bundle: { ...bundle, annotations: [] } }),
    });
    check("Rejects an empty annotation list", empty.status === 400, `HTTP ${empty.status}`);

    // ── Directory traversal ───────────────────────────────────────────────
    // Two kinds of request must be told apart or the conclusion will be wrong
    // (found.md F-018):
    //
    // A. `..`, `%2e%2e` — **foldable per the URL spec**: by the time Hono sees it,
    //    `c.req.path` holds no `..` segment at all (observed: `/%2e%2e/%2e%2e/etc/passwd`
    //    arrives as `/etc/passwd`). It is equivalent to "a path that does not exist",
    //    and answering with the SPA shell 200 is correct behaviour, not a hole.
    // B. `%2f` (encoded slash) — **not foldable**: it reaches our own path parsing as
    //    a `..` segment, and that is the attack surface that must be blocked.
    //
    // The security invariant is therefore "never leak the target file's contents",
    // which both kinds must satisfy; returning 403 in addition only matters for B.
    const attacks: Array<{ path: string; mustBlock: boolean }> = [
      { path: "/../../../../etc/passwd", mustBlock: false },
      { path: "/%2e%2e/%2e%2e/%2e%2e/etc/passwd", mustBlock: false },
      { path: "/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd", mustBlock: true },
      { path: "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json", mustBlock: true },
    ];

    for (const attack of attacks) {
      const raw = await rawRequest(
        server.port,
        `GET ${attack.path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
      const status = Number(raw.slice(9, 12));
      const leaked =
        raw.includes("root:x:") ||
        raw.includes('"name": "@mystudio/desktop"') ||
        raw.includes("/bin/bash");
      const blocked = status === 403 || status === 400;
      const ok = !leaked && (attack.mustBlock ? blocked : status === 200 || blocked);
      check(
        `Traversal ${attack.path}${attack.mustBlock ? " (must be blocked)" : " (folded by URL)"}`,
        ok,
        `HTTP ${status}${leaked ? "  LEAKED CONTENT!" : ""}`,
      );
    }

    // Invalid percent-encoding must not disguise itself as an SPA route.
    const malformed = await rawRequest(
      server.port,
      "GET /%zz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    check("Invalid percent-encoding returns 400", Number(malformed.slice(9, 12)) === 400, `HTTP ${malformed.slice(9, 12)}`);

    // Also confirm a normal SPA sub-route still falls back (blocking must not become over-rejection).
    const spa = await fetch(`${server.url}/some/client/route`);
    check("SPA sub-routes still fall back", spa.status === 200, `HTTP ${spa.status}`);
  } finally {
    await server.close();
  }

  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  return failed === 0 ? 0 : 1;
}

// Called explicitly rather than a top-level await: the exit code must reflect the result.
main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n[FAILED] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
