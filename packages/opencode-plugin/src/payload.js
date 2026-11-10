/**
 * Payload validation.
 *
 * The inbox (HTTP) and the file outbox share one contract, so validation must have
 * exactly one implementation — writing it twice eventually diverges, and the symptom
 * is the nastiest kind: "HTTP accepts it, files do not".
 *
 * ## Ink-only payloads are valid
 *
 * Handwriting is delivered as a picture of the frame, not as a numbered block, so a
 * payload the user only scribbled on has `annotations: []` and `ink: [...]`. An earlier
 * version required at least one annotation and therefore rejected exactly that case at
 * the inbox — while the desktop had already accepted it and shown "Sending". The
 * protocol's own `validateBundle` states the rule: handwriting counts as content.
 *
 * @typedef {object} InboxPayload
 * @property {1} schemaVersion
 * @property {string} prompt
 * @property {{projectDir: string, projectId: string, summary: string, annotations: unknown[], ink?: unknown[], elements?: unknown[]}} bundle
 * @property {string} [targetSessionID]
 */

/**
 * @param {any} payload
 * @returns {string | null} reason when invalid, null when valid
 */
export function validatePayload(payload) {
  if (typeof payload !== "object" || payload === null) return "Request body must be an object";
  if (payload.schemaVersion !== 1) return `Unsupported protocol version: ${String(payload.schemaVersion)}`;
  if (typeof payload.prompt !== "string" || payload.prompt.trim() === "") return "Missing prompt text";
  const bundle = payload.bundle;
  if (typeof bundle !== "object" || bundle === null) return "Missing annotation data";
  if (typeof bundle.projectDir !== "string" || bundle.projectDir.trim() === "") {
    return "Missing project directory";
  }

  const annotations = Array.isArray(bundle.annotations) ? bundle.annotations.length : 0;
  const ink = Array.isArray(bundle.ink) ? bundle.ink.length : 0;
  const elements = Array.isArray(bundle.elements) ? bundle.elements.length : 0;
  if (annotations === 0 && ink === 0 && elements === 0) {
    return "No annotations in the payload";
  }

  if (typeof payload.targetSessionID !== "undefined" && typeof payload.targetSessionID !== "string") {
    return "targetSessionID must be a string when present";
  }
  if (typeof payload.appId !== "undefined" && typeof payload.appId !== "string") {
    return "appId must be a string when present";
  }

  return null;
}
