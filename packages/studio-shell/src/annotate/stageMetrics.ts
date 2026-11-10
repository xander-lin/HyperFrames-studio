/**
 * The preview stage: where the picture is on screen, and whether it moved.
 *
 * The stage is the annotation layer's coordinate origin. Everything drawn is normalised
 * against it, so this module answers exactly two questions and nothing else:
 *
 * 1. **Where is it?** — the preview iframe's bounding box.
 * 2. **Did it move?** — compared with a sub-pixel tolerance, because a new object every
 *    frame would re-render the whole annotation UI and look like flickering.
 *
 * Pure and React-free so the comparison rule can be tested without a DOM.
 */

/** The picture's rect in viewport coordinates (client space). */
export interface PreviewStageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Whether two stage rects are equivalent (including both being null). */
export function sameStageRect(
  a: PreviewStageRect | null,
  b: PreviewStageRect | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** The subset of `HTMLIFrameElement` this module needs; a real iframe satisfies it. */
export interface MeasurableFrame {
  readonly isConnected: boolean;
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** The iframe's box, or null while it is unmounted or has no area. */
export function measureStage(iframe: MeasurableFrame | null): PreviewStageRect | null {
  if (!iframe || !iframe.isConnected) return null;
  const rect = iframe.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
