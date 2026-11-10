/**
 * The desktop app's own HTTP layer.
 *
 * It does three things, all on one loopback port:
 * 1. serve the Studio fork's static build (`/`);
 * 2. provide the bridge endpoints (`/__mystudio/*`): config, frame saving, delivery;
 * 3. proxy every other `/api/*` request to the Hyperframes preview service — all of
 *    Studio's backend (assets, timeline, rendering, thumbnails) passes through, and
 *    we do not reimplement a single line of it.
 *
 * Why Studio does not simply talk to the preview service directly: a different port
 * means a different origin, which breaks cookies/credentials and
 * `iframe.contentDocument` (readable only same-origin), so the annotation layer
 * could not pick elements. A same-origin proxy solves it once.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type {
  DeliverResponse,
  HostConfig,
  OpenProjectResponse,
  SaveFrameRequest,
  SaveFrameResponse,
  SubscribersResponse,
} from "@mystudio/protocol";
import { BRIDGE_ROUTES } from "@mystudio/protocol";
import type { PromptSink } from "@mystudio/protocol";
import { validateBundle } from "@mystudio/protocol";
import { listSubscriptions } from "@mystudio/protocol/node";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export interface OpenProjectResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly cancelled?: boolean;
}

export interface AppServerOptions {
  /**
   * Quit the app. A frameless window on a tiling desktop has no system close
   * button, so the app needs its own exit (the sprite's "Quit" row).
   */
  readonly onQuit?: () => void;
  /**
   * Open a different project: show the picker, resolve a folder of projects, switch.
   *
   * Optional so the server can be constructed in tests without an Electron dialog.
   */
  readonly onOpenProject?: () => Promise<OpenProjectResult>;
  /**
   * This launch's app id.
   *
   * Subscriptions are keyed by it, so it answers "which app did this conversation
   * subscribe to". Missing means no subscriptions can exist, which the subscribers route
   * reports as an empty list rather than as an error.
   */
  readonly appId?: string;
  /** Registry root override for tests. */
  readonly registryRoot?: string;
  /** Directory holding the Studio fork's build output (with index.html). */
  readonly studioDir: string;
  /** Local Hyperframes preview origin. */
  readonly previewOrigin: string;
  /** Config the frontend reads at startup. */
  readonly config: HostConfig;
  /** Assembled delivery channel; null means unconfigured. */
  readonly sink: PromptSink | null;
  /** Directory for saved frame captures. */
  readonly framesDir: string;
  /** Injection point for tests. */
  readonly fetchImpl?: typeof fetch;
}

export type FrameWriter = (request: SaveFrameRequest) => Promise<string>;

/**
 * Default frame writer: write `<annotationId>.png` into the given directory.
 *
 * Named after the annotation id rather than a timestamp, so re-delivering the same
 * annotation overwrites its old image instead of littering.
 */
export function createFrameWriter(framesDir: string): FrameWriter {
  return async (request) => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(framesDir, { recursive: true });
    // The id comes from the frontend and must be sanitized before joining paths,
    // otherwise `../` can write outside the directory.
    const safeId = request.annotationId.replace(/[^A-Za-z0-9_-]/g, "_");
    const target = join(framesDir, `${safeId}.png`);
    const buffer = Buffer.from(request.pngBase64, "base64");
    await writeFile(target, buffer);
    return target;
  };
}

export function createAppServer(options: AppServerOptions): Hono {
  const app = new Hono();
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const writeFrame = createFrameWriter(options.framesDir);

  app.get(BRIDGE_ROUTES.config, (c) => c.json(options.config));

  app.post(BRIDGE_ROUTES.openProject, async (c) => {
    if (!options.onOpenProject) {
      return c.json<OpenProjectResponse>({ ok: false, error: "No open handler configured" }, 501);
    }
    /*
     * Reply only after the switch finished. The window navigates to the new project,
     * which destroys the requesting page, so a "started" acknowledgement would be a
     * promise the caller can never observe.
     */
    const result = await options.onOpenProject();
    return c.json<OpenProjectResponse>(result);
  });

  app.post(BRIDGE_ROUTES.quit, (c) => {
    if (!options.onQuit) return c.json({ ok: false, error: "No quit handler configured" }, 501);
    // Reply first, then quit: otherwise the request is cut off when the window
    // closes and the frontend never sees a result.
    setTimeout(() => options.onQuit?.(), 50);
    return c.json({ ok: true });
  });

  // ── Subscribers ─────────────────────────────────────────────────────────
  /*
   * Read-only, deliberately: a subscription is declared **from inside the conversation**
   * that wants the annotations (the plugin's `mystudio_subscribe` tool). This app cannot
   * enumerate OpenCode sessions, and picking one on the user's behalf is exactly the
   * guessing this design removed.
   *
   * Exposing it is still necessary: the user must be able to see who will receive the next
   * annotation, and to notice that nobody has subscribed yet.
   */
  app.get(BRIDGE_ROUTES.subscribers, async (c) => {
    if (!options.appId) {
      return c.json<SubscribersResponse>({ ok: false, error: "This app has no identity" }, 200);
    }
    try {
      const subscriptions = await listSubscriptions(options.appId, options.registryRoot);
      return c.json<SubscribersResponse>({
        ok: true,
        subscribers: subscriptions.map((entry) => ({
          sessionID: entry.sessionID,
          ...(entry.sessionTitle ? { title: entry.sessionTitle } : {}),
          createdAt: entry.createdAt,
        })),
      });
    } catch (error) {
      return c.json<SubscribersResponse>({ ok: false, error: describeError(error) }, 200);
    }
  });

  app.post(BRIDGE_ROUTES.frame, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isSaveFrameRequest(body)) {
      return c.json<SaveFrameResponse>({ ok: false, error: "Malformed request body" }, 400);
    }
    try {
      const path = await writeFrame(body);
      return c.json<SaveFrameResponse>({ ok: true, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json<SaveFrameResponse>({ ok: false, error: message }, 500);
    }
  });

  app.post(BRIDGE_ROUTES.deliver, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isDeliverRequest(body)) {
      return c.json<DeliverResponse>(
        { outcome: { ok: false, code: "rejected", message: "Malformed request body" }, sink: null },
        400,
      );
    }
    const invalid = validateBundle(body.bundle);
    if (invalid) {
      return c.json<DeliverResponse>(
        { outcome: { ok: false, code: "rejected", message: invalid }, sink: null },
        400,
      );
    }
    if (!options.sink) {
      return c.json<DeliverResponse>({
        outcome: {
          ok: false,
          code: "unreachable",
          message:
            "No delivery channel configured: set the OpenCode plugin endpoint or an outbox directory in the desktop app",
        },
        sink: null,
      });
    }
    /*
     * No destination is resolved here any more.
     *
     * The sink fans out to this app's subscribers; an explicit `targetSessionID` can only
     * narrow that set, never invent a destination.
     */
    const requested = typeof body.targetSessionID === "string" ? body.targetSessionID : null;
    const outcome = await options.sink.deliver(
      body.bundle,
      body.prompt,
      requested ? { targetSessionID: requested } : {},
    );
    return c.json<DeliverResponse>({ outcome, sink: options.sink.name });
  });

  // ── Reverse proxy to Hyperframes preview ────────────────────────────────
  // Must be registered before static serving, or /api/* is treated as a static
  // file and 404s.
  app.all("/api/*", async (c) => proxyToPreview(c.req.raw, options.previewOrigin, doFetch));

  // ── Static hosting ──────────────────────────────────────────────────────
  app.all("*", async (c) => serveStatic(c.req.path, options.studioDir));

  return app;
}

async function proxyToPreview(
  request: Request,
  origin: string,
  doFetch: typeof fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);

  // Hop-by-hop headers must not pass through: Host has to become the upstream's or
  // the preview service rejects it (it has DNS-rebinding protection); content-length
  // is recomputed by fetch.
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await doFetch(target.toString(), {
      method: request.method,
      headers,
      body,
      // SSE (/api/events) and streaming renders need the raw body stream passed
      // through, not buffered.
      redirect: "manual",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: `Preview service unreachable: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Return the upstream Response as-is: Hono writes the body stream through, so SSE
  // keeps pushing.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function serveStatic(pathname: string, root: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Invalid percent-encoding (e.g. `%zz`): answering with the SPA shell would mask
    // what looks like probing.
    return new Response("Bad Request", { status: 400 });
  }

  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(join(root, relative));

  // Directory traversal guard: the resolved path must stay inside root.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Explicitly reject any `..` or `.` segment even if it was neutralised inside root.
  // Reason: such a request can only come from an attack attempt or a frontend path
  // bug; falling back to the SPA shell returns 200, which both masks the problem and
  // stops automated security checks from telling "harmless" apart from "blocked".
  // See found.md F-018.
  if (relative.split(/[\\/]/).some((segment) => segment === ".." || segment === ".")) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = await resolveFile(candidate, root, relative);
  if (!file) return new Response("Not Found", { status: 404 });

  const data = await readFile(file);
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      // No aggressive caching for static assets: Studio is a local development tool,
      // and "changes are visible immediately" beats saving bytes.
      "cache-control": "no-store",
    },
  });
}

/**
 * Find the file to return: a direct hit wins; otherwise fall back to index.html
 * (SPA routing).
 *
 * The fallback applies only to paths that look like page requests — a path with an
 * extension that does not exist must 404, otherwise a missing image returns a whole
 * HTML document and the frontend gets harder to debug.
 */
async function resolveFile(
  candidate: string,
  root: string,
  relative: string,
): Promise<string | null> {
  const direct = await statSafe(candidate);
  if (direct?.isFile()) return candidate;

  const indexInDir = await statSafe(join(candidate, "index.html"));
  if (indexInDir?.isFile()) return join(candidate, "index.html");

  if (extname(relative) !== "") return null;

  const fallback = join(root, "index.html");
  const entry = await statSafe(fallback);
  return entry?.isFile() ? fallback : null;
}

async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(normalize(path));
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSaveFrameRequest(value: unknown): value is SaveFrameRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "annotationId" in value &&
    typeof value.annotationId === "string" &&
    "pngBase64" in value &&
    typeof value.pngBase64 === "string"
  );
}

function isDeliverRequest(value: unknown): value is {
  schemaVersion: 1;
  prompt: string;
  bundle: Parameters<typeof validateBundle>[0];
  targetSessionID?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "prompt" in value &&
    typeof value.prompt === "string" &&
    "bundle" in value &&
    typeof value.bundle === "object" &&
    value.bundle !== null
  );
}

export interface StartedServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the server. The preferred port is a hint: if it is taken, scan forward —
 * a user with two projects open should never see "port already in use".
 */
export async function startAppServer(
  options: AppServerOptions,
  preferredPort = 4317,
): Promise<StartedServer> {
  const app = createAppServer(options);
  const max = preferredPort + 40;

  for (let port = preferredPort; port <= max; port += 1) {
    try {
      const server = await listenOn(app, port);
      return {
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      };
    } catch (error) {
      if (!isPortBusy(error)) throw error;
    }
  }
  throw new Error(`Ports ${preferredPort}–${max} are all in use`);
}

function listenOn(app: Hono, port: number): Promise<ReturnType<typeof serve>> {
  return new Promise((resolveListen, rejectListen) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
      resolveListen(server),
    );
    server.on("error", rejectListen);
  });
}

function isPortBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EADDRINUSE" || error.code === "EACCES")
  );
}
