/**
 * Injection core: turn an annotation payload into one user message inside an
 * OpenCode session.
 *
 * Deliberately free of HTTP and filesystem concerns — it takes only `ctx` (the plugin
 * context) and a payload. That keeps the injection strategy unit-testable and makes
 * it easy to change how prompts are injected later.
 *
 * The v2 `session.prompt` shape (per `SessionPromptInput` in
 * `@opencode/client@2.2.6`):
 *
 * ```ts
 * {
 *   sessionID: string,
 *   text: string,
 *   files?: [...],
 *   delivery?: "steer" | "queue",
 *   resume?: boolean,
 * }
 * ```
 *
 * `delivery: "queue"` plus `resume: false` is the correct combination: enqueue for the
 * user's pending turn, without interrupting and without auto-running, so the user
 * consumes it on their next interaction. That is the technical form of "do not replace
 * the user's conversation". `steer` is never used — it cuts in line and interrupts.
 */

import { resolveTargetSession } from "./sessionTarget.js";

/**
 * Re-exported so `injector.js` remains the single entry point for "injection
 * capability"; the selection rules themselves live in `sessionTarget.js`.
 */
export { resolveTargetSession, pickBestSession, viewedAt } from "./sessionTarget.js";

/**
 * @typedef {object} InboxPayload
 * @property {1} schemaVersion
 * @property {string} prompt
 * @property {{projectDir: string, projectId: string, summary: string, annotations: Array<{frameImagePath?: string}>, ink?: Array<{imagePath: string}>}} bundle
 * @property {string} [targetSessionID]
 */

/**
 * @typedef {"queue" | "run"} DeliveryMode
 */

/**
 * Collect the images a payload refers to, as prompt file attachments.
 *
 * Two kinds, and the distinction matters:
 *
 * - **Frame captures of numbered marks** — a clean picture of the frame at the timecode
 *   the region or arrow refers to. It is evidence, the mark itself being coordinates.
 * - **Handwriting pictures** (`bundle.ink`) — the frame *with the user's strokes on it*.
 *   Here the image is not evidence, it is the message: handwriting has no coordinates
 *   worth reading and no block reference, so what the reader needs is to see it.
 *
 * Why attach at all: the prompt text names screenshots by absolute path, and an agent
 * that cannot (or does not bother to) open an image gets much less out of the request.
 * Attaching puts the picture in front of the model directly.
 *
 * Only `file://` URIs are used. A plain filesystem path is not a valid attachment
 * source, and silently attaching nothing would make the loss invisible, so files that
 * cannot be represented are simply skipped — the path is still in the text.
 *
 * @param {InboxPayload} payload
 * @returns {Array<{uri: string, source: {type: "uri", uri: string}, name: string, description: string}>}
 */
export function collectFrameAttachments(payload) {
  /** @type {Array<{uri: string, source: {type: "uri", uri: string}, name: string, description: string}>} */
  const files = [];

  const annotations = payload?.bundle?.annotations;
  if (Array.isArray(annotations)) {
    for (let index = 0; index < annotations.length; index += 1) {
      const path = annotations[index]?.frameImagePath;
      if (typeof path !== "string" || path.trim() === "") continue;
      const uri = toFileUri(path.trim());
      if (!uri) continue;
      files.push({
        uri,
        // `source` is optional in the schema, but stating it makes the intent explicit:
        // the image is read from that URI rather than inlined in the request.
        source: { type: "uri", uri },
        name: `annotation-${index + 1}.png`,
        description: `Clean capture of the frame for annotation ${index + 1}`,
      });
    }
  }

  /*
   * Handwriting, attached last so the numbered marks stay first: those are what the
   * user's sentences name, and the reader should meet them before the pictures.
   */
  const ink = payload?.bundle?.ink;
  if (Array.isArray(ink)) {
    for (let index = 0; index < ink.length; index += 1) {
      const path = ink[index]?.imagePath;
      if (typeof path !== "string" || path.trim() === "") continue;
      const uri = toFileUri(path.trim());
      if (!uri) continue;
      files.push({
        uri,
        source: { type: "uri", uri },
        name: `handwriting-${index + 1}.png`,
        description: `Frame as the user wrote on it (handwriting is the instruction, not decoration)`,
      });
    }
  }

  return files;
}

/**
 * Turn a filesystem path into a `file://` URI.
 *
 * @param {string} path
 * @returns {string | null}
 */
function toFileUri(path) {
  if (path.startsWith("file://")) return path;
  // Only absolute paths can be addressed; a relative one is meaningless to OpenCode,
  // whose working directory may be anything.
  if (!path.startsWith("/")) return null;
  return `file://${path.split("/").map(encodeURIComponent).join("/").replace(/^%2F/, "/")}`;
}

/**
 * Inject a payload into a session.
 *
 * @param {any} ctx OpenCode plugin context
 * @param {InboxPayload} payload
 * @param {{mode?: DeliveryMode, lastViewedSessionID?: string | null}} [options]
 * @returns {Promise<{sessionID: string, title?: string, created: boolean, mode: DeliveryMode, reason: string, attachments: number}>}
 */
export async function injectPayload(ctx, payload, options = {}) {
  const mode = options.mode === "run" ? "run" : "queue";

  const projectDir = payload?.bundle?.projectDir;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new Error("Payload has no project directory, so the target session is unknown");
  }

  const target = await resolveTargetSession(ctx, projectDir, payload?.targetSessionID, {
    lastViewedSessionID: options.lastViewedSessionID ?? null,
  });

  const files = collectFrameAttachments(payload);

  await ctx.session.prompt({
    sessionID: target.sessionID,
    text: payload.prompt,
    ...(files.length > 0 ? { files } : {}),
    delivery: mode === "run" ? "steer" : "queue",
    ...(mode === "run" ? {} : { resume: false }),
  });

  return {
    sessionID: target.sessionID,
    ...(target.title ? { title: target.title } : {}),
    created: target.created,
    mode,
    reason: target.reason,
    attachments: files.length,
  };
}

/**
 * Inject one payload at a time. One failure must not stop the rest: a single bad
 * record should not block the whole queue.
 *
 * @param {any} ctx
 * @param {InboxPayload[]} payloads
 * @param {{mode?: DeliveryMode, lastViewedSessionID?: string | null}} [options]
 * @returns {Promise<{delivered: number, failures: Array<{index: number, message: string}>}>}
 */
export async function injectAll(ctx, payloads, options = {}) {
  /** @type {Array<{index: number, message: string}>} */
  const failures = [];
  let delivered = 0;

  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    if (!payload) continue;
    try {
      await injectPayload(ctx, payload, options);
      delivered += 1;
    } catch (error) {
      failures.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { delivered, failures };
}
