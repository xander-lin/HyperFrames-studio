/**
 * Composing the annotated frame into one image, for handwriting.
 *
 * ## Why ink is delivered as a picture rather than as data
 *
 * A region or an arrow is a *reference*: "this area", "move that here". Giving it a
 * number is what lets the user write `Arrow 2` in a sentence and be understood.
 *
 * Handwriting is not a reference. Its meaning is the mark itself — a circle drawn around
 * a word, a scribbled correction, an arrow sketched by hand. Reducing that to
 * "Freehand 3, 84 points, starts here, ends there" throws away the only part a reader
 * can use. What actually communicates it is **the frame as the user sees it**: the video
 * with their strokes on top.
 *
 * So this module produces exactly that image: the clean captured frame, plus the ink,
 * at the frame's own resolution.
 *
 * ## Why the ink is drawn here instead of screenshotting the page
 *
 * Screenshotting the page would capture the whole window — toolbars, prompt box, the
 * dock — and it would bake in whatever zoom the window happens to have. Redrawing from
 * the stored normalized points onto the frame's own pixels gives an image at the
 * composition's design size, with only the picture and the strokes, regardless of the
 * window that produced it.
 */

import type { AnnotationShape, InkPoint, Point } from "@mystudio/protocol";
import { paintShape, SHAPE_LINE_WIDTH } from "./shapePainter.js";

export interface ComposeInkOptions {
  /** The clean captured frame, base64 PNG. */
  readonly framePngBase64: string;
  /**
   * **Every** mark on this frame, in painting order.
   *
   * Not just ink. The user's rule is "我看见什么，它就看见什么": a delivered capture that
   * dropped the arrows and boxes visible on screen showed the reader a different picture from
   * the one being annotated (found.md F-110).
   */
  readonly shapes: readonly AnnotationShape[];
  /** Badge ordinal per shape, in the same order; `null` where the shape is not numbered. */
  readonly badges?: readonly (string | null)[];
  /**
   * Stroke width, in pixels of the **output image**.
   *
   * Passed in rather than derived: the correct value depends on how large the ink looks
   * on the user's screen, which is a property of the preview, not of the composition.
   * The caller converts it once through the stage-to-image ratio.
   */
  readonly strokeScale: number;
}

export type ComposeInkResult =
  | { readonly ok: true; readonly pngBase64: string }
  | { readonly ok: false; readonly message: string };

/**
 * Draw the strokes over the frame and return a PNG.
 *
 * The frame is drawn at its **natural size**, so the result is the same resolution as
 * the capture: a 1920×1080 composition produces a 1920×1080 image, not whatever the
 * window happened to be.
 */
export async function composeInk(
  options: ComposeInkOptions,
  createImage: (source: string) => Promise<HTMLImageElement> = loadImage,
): Promise<ComposeInkResult> {
  const source = `data:image/png;base64,${options.framePngBase64}`;

  let image: HTMLImageElement;
  try {
    image = await createImage(source);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, message: "The captured frame has no size" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, message: "This browser would not provide a 2D canvas" };

  ctx.drawImage(image, 0, 0, width, height);

  /*
   * Same colour and halo as on screen.
   *
   * The halo matters more here than in the app: the delivered image is read by a model
   * looking at one picture with no ability to toggle anything, so ink that vanishes
   * against a white slide is simply lost. A darker pass underneath keeps it readable on
   * any background.
   */
  /*
   * The same painter the live canvas uses, so the delivered image cannot drift from what the
   * user was looking at. `strokeScale` covers the difference between screen pixels and
   * composition pixels; the badge is scaled the same way so its text stays legible.
   */
  const toPixels = (point: Point): Point => ({ x: point.x * width, y: point.y * height });
  const toInkPixels = (point: InkPoint): InkPoint => ({
    x: point.x * width,
    y: point.y * height,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  });

  options.shapes.forEach((shape, index) => {
    paintShape(
      ctx,
      shape,
      toPixels,
      toInkPixels,
      SHAPE_LINE_WIDTH * options.strokeScale,
      options.badges?.[index] ?? null,
      options.strokeScale,
    );
  });

  try {
    return { ok: true, pngBase64: stripDataUrl(canvas.toDataURL("image/png")) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Decode a data URL into an image element, rejecting on a broken payload. */
function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The captured frame could not be decoded"));
    image.src = source;
  });
}

function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * How much to scale stroke width when moving from the preview to the image.
 *
 * A stroke drawn 2px wide on a 480px-wide preview must be 8px wide in a 1920px image, or
 * it would look like a hairline compared to what the user drew. Ratio of the two widths
 * is the whole rule; clamping keeps a wildly different window from producing ink that is
 * invisible or a blob.
 */
export function inkScaleForFrame(stageWidth: number, frameWidth: number): number {
  if (stageWidth <= 0 || frameWidth <= 0) return 1;
  const ratio = frameWidth / stageWidth;
  return Math.min(8, Math.max(0.25, ratio));
}
