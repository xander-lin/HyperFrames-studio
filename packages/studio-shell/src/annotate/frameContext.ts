/**
 * Read the authoritative "current frame" information from Studio.
 *
 * Three things must come from Studio rather than being computed here:
 * 1. the current composition's path (which may be a nested sub-composition)
 * 2. the playhead's exact time
 * 3. the composition's design size
 *
 * That data lives across two stores/contexts. **Context wins**: 
 * `StudioShellValue.activeCompPath` is the authority, and the URL hash is only its
 * persisted mirror — it lags while switching or restoring an unfinished session. So
 * the React side passes the context value in explicitly and falls back to the hash
 * only when unavailable.
 */

import type { FrameRef } from "@mystudio/protocol";
import { parseStudioUrlStateFromHash } from "../utils/studioUrlState";

/** Hyperframes' default canvas size, used when data-width/height cannot be read. */
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

/** Provided by the caller from Studio's context, because this module is not a hook. */
export interface FrameOverrides {
  readonly activeCompPath?: string | null;
  readonly compositionWidth?: number | null;
  readonly compositionHeight?: number | null;
  readonly time?: number | null;
}

export interface FrameSnapshot {
  readonly frame: FrameRef;
  /** The preview iframe's document, for the caller to pick elements and capture. */
  readonly doc: Document | null;
}

/** `contentDocument` throws when cross-origin or unmounted; treat both as "unavailable". */
export function safeContentDocument(iframe: HTMLIFrameElement | null): Document | null {
  if (!iframe) return null;
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

/**
 * Read the canvas size from the preview document.
 *
 * It reads `data-width` / `data-height` on the composition root — Hyperframes writes
 * its design size into the composition HTML, which is more authoritative than the
 * iframe's actual pixels (the user may have zoomed the preview).
 */
export function readCompositionSize(doc: Document | null): { width: number; height: number } {
  if (!doc) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

  const root = doc.querySelector("[data-composition-id]") ?? doc.body;
  const rawWidth = root?.getAttribute("data-width");
  const rawHeight = root?.getAttribute("data-height");
  const width = rawWidth ? Number.parseInt(rawWidth, 10) : Number.NaN;
  const height = rawHeight ? Number.parseInt(rawHeight, 10) : Number.NaN;
  return {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT,
  };
}

/**
 * Parse the current composition from the URL hash.
 *
 * Reuses Studio's own parser so the two rules cannot diverge. Falls back to
 * `index.html`, the project's main composition and the most likely answer when the
 * user has not said otherwise.
 */
export function compositionPathFromHash(hash: string): string {
  return normalizeCompositionPath(parseStudioUrlStateFromHash(hash).activeCompPath);
}

/** A composition path always ends in `.html`; empty falls back to the project entry. */
export function normalizeCompositionPath(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) return "index.html";
  return trimmed.endsWith(".html") ? trimmed : `${trimmed}.html`;
}

/**
 * Aggregate the current frame info. `time` and `iframe` are passed in by the caller;
 * everything else is optional.
 *
 * Precedence: explicit overrides > data attributes in the preview document >
 * defaults.
 */
export function snapshotFrame(params: {
  readonly currentTime: number;
  readonly iframe: HTMLIFrameElement | null;
  readonly overrides?: FrameOverrides;
  readonly hash?: string;
}): FrameSnapshot {
  const doc = safeContentDocument(params.iframe);
  const overrides = params.overrides ?? {};

  const measured = readCompositionSize(doc);
  const width = positive(overrides.compositionWidth) ?? measured.width;
  const height = positive(overrides.compositionHeight) ?? measured.height;

  const compositionPath = normalizeCompositionPath(overrides.activeCompPath ?? compositionPathFromHash(params.hash ?? safeHash()));

  const time = Number.isFinite(params.currentTime) ? Math.max(0, params.currentTime) : 0;

  return {
    frame: { compositionPath, time, compositionWidth: width, compositionHeight: height },
    doc,
  };
}

function positive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function safeHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}
