/**
 * Capture the "clean frame at this moment".
 *
 * Key decision: **do not screenshot the outer page, and do not capture the iframe's
 * canvas.**
 *
 * Reasoning: the annotation layer is drawn on the outer page, so capturing the
 * outer page would bake the strokes in; and a composition may be DOM + CSS + canvas
 * + video mixed, so grabbing the canvas only gets one layer.
 *
 * The right move is to reuse Hyperframes' own frame-capture endpoint: it seeks to
 * the timecode and renders the whole frame exactly as the final render will look
 * (found.md F-007):
 *
 *   GET /api/projects/<id>/thumbnail/<comp>?t=<seconds>&format=png&output=source
 *
 * Key detail: the request must use a **same-origin relative URL**.
 * The renderer runs on the desktop app server (e.g. 4317) while the preview service
 * is on another port (e.g. 3003). Requesting the preview port directly is
 * cross-origin and gets blocked by CORS — silently, so captures are always missing
 * (found.md F-014). The app server already proxies `/api/*` to preview, so a
 * relative path is enough.
 */

import type { FrameRef } from "@mystudio/protocol";

export interface FrameCaptureOptions {
  readonly projectId: string;
}

/** Build the frame capture URL (same-origin relative path). */
export function buildFrameUrl(frame: FrameRef, options: FrameCaptureOptions): string {
  const comp = frame.compositionPath.trim() || "index.html";
  const params = new URLSearchParams({
    t: Math.max(0, frame.time).toFixed(3),
    format: "png",
    // output=source means native density at the composition's design size, without
    // preview downsampling. The image sent to the agent must be legible.
    output: "source",
    // v is a cache key: including the time prevents getting the previous frame.
    v: String(Date.now()),
  });
  return `/api/projects/${encodeURIComponent(options.projectId)}/thumbnail/${encodeURIComponent(comp)}?${params.toString()}`;
}

export type FrameCaptureResult =
  | { readonly ok: true; readonly pngBase64: string }
  | { readonly ok: false; readonly message: string };

/** Capture one frame and turn it into base64 for the bridge to save. */
export async function captureFrame(
  frame: FrameRef,
  options: FrameCaptureOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FrameCaptureResult> {
  let response: Response;
  try {
    response = await fetchImpl(buildFrameUrl(frame, options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Frame capture request failed: ${message}` };
  }

  if (!response.ok) {
    return { ok: false, message: `Frame capture returned HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    // The server answers with a JSON error body when the composition is missing;
    // recognise that instead of saving it as an image.
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      message: `Frame capture did not return an image (${contentType || "no type"})${body ? `: ${body.slice(0, 120)}` : ""}`,
    };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) return { ok: false, message: "Frame capture returned an empty body" };
  return { ok: true, pngBase64: arrayBufferToBase64(buffer) };
}

/**
 * ArrayBuffer → base64.
 *
 * Not btoa (latin1 only — it throws on PNG binary) and not Node's Buffer (absent in
 * the browser). Written by hand so it runs on both sides.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
