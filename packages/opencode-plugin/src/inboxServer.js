/**
 * The plugin's inbox HTTP server.
 *
 * It is the only network seam between MyStudio and OpenCode, so it is deliberately
 * minimal: one route (POST /annotations), one job (turn it into a session message).
 * It does not parse prompts, touch a model or keep state.
 *
 * It binds to loopback only: this is an unauthenticated local injection endpoint, and
 * exposing it to the LAN means letting anyone put instructions into your AI session.
 */

import { createServer } from "node:http";
import { injectPayload } from "./injector.js";
import { validatePayload } from "./payload.js";

/** Keep in sync with the desktop app's DEFAULT_INBOX. */
export const DEFAULT_PORT = 47812;

/**
 * How many ports to try before giving up.
 *
 * Two OpenCode servers each run their own plugin instance, and both want the default port.
 * Scanning means the second gets the next free one instead of failing to start — and since
 * every subscription records the endpoint of the plugin that wrote it, the app can still
 * reach both.
 */
const PORT_SCAN = 20;

/** Body limit: a prompt plus structured annotations; 1MB is ample and blocks abuse. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Start the inbox.
 *
 * @param {object} options
 * @param {any} options.ctx OpenCode plugin context
 * @param {number} [options.port] 0 lets the OS assign a free port
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @param {{last: () => ({sessionID: string, at: number} | null)} | null} [options.viewed]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startInbox({ ctx, port = DEFAULT_PORT, log = () => {}, viewed = null }) {
  const server = createServer((request, response) => {
    void handle(request, response, { ctx, log, viewed });
  });

  const boundPort = await listenFirstFree(server, port);
  return {
    port: boundPort,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose(undefined));
      }),
  };
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {{ctx: any, log: (msg: string, detail?: unknown) => void, viewed: {last: () => ({sessionID: string, at: number} | null)} | null}} deps
 */
async function handle(request, response, deps) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/health") {
    return respond(response, 200, { ok: true });
  }

  if (url.pathname !== "/annotations" || request.method !== "POST") {
    return respond(response, 404, { error: "not found" });
  }

  let raw;
  try {
    raw = await readBody(request);
  } catch (error) {
    return respond(response, 413, {
      error: error instanceof Error ? error.message : "Request body too large",
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return respond(response, 400, { error: "Request body is not valid JSON" });
  }

  const invalid = validatePayload(payload);
  if (invalid) return respond(response, 400, { error: invalid });

  try {
    /*
     * `lastViewedSessionID` is the live "which window is the user in" signal. Passing it
     * in (rather than letting `injector` reach for a module global) keeps the selection
     * rule testable from the inbox alone.
     */
    const result = await injectPayload(deps.ctx, payload, {
      lastViewedSessionID: deps.viewed?.last()?.sessionID ?? null,
    });
    deps.log(
      `Injected annotation into session ${result.sessionID}${result.created ? " (created)" : ""}`,
      {
        annotations: payload.bundle.annotations.length,
        ink: Array.isArray(payload.bundle.ink) ? payload.bundle.ink.length : 0,
        reason: result.reason,
        title: result.title,
      },
    );
    /*
     * The answer names the session. The desktop shows it, so "sent" is not a promise the
     * user has to take on faith.
     */
    return respond(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log("Injection failed", { error: message });
    return respond(response, 500, { error: message });
  }
}

/**
 * Bind the first free port at or after `start`.
 *
 * A busy port is not an error here: it almost always means another OpenCode server is
 * already listening, and refusing to start would disable subscription for this one.
 *
 * @param {import("node:http").Server} server
 * @param {number} start
 * @returns {Promise<number>}
 */
async function listenFirstFree(server, start) {
  let lastError = null;
  for (let candidate = start; candidate < start + PORT_SCAN; candidate += 1) {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => rejectListen(error);
        server.once("error", onError);
        server.listen(candidate, "127.0.0.1", () => {
          server.off("error", onError);
          resolveListen(undefined);
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : candidate;
    } catch (error) {
      lastError = error;
      if (!isPortBusy(error)) throw error;
    }
  }
  throw lastError ?? new Error(`No free port in ${start}–${start + PORT_SCAN}`);
}

function isPortBusy(error) {
  const code = error && typeof error === "object" ? error.code : null;
  return code === "EADDRINUSE" || code === "EACCES";
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        rejectBody(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function respond(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
