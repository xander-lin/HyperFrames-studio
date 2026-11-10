/**
 * Composing a whiteboard page into one image, for a `Drawing N` block.
 *
 * ## Why the board needs its own picture at all
 *
 * The video's picture is "the clean frame plus your marks", which the frame-capture endpoint
 * can produce because a frame exists. A board has no frame: the page **is** the content, and
 * swapping the video out is exactly what the user asked for. So the picture has to be drawn
 * here, from the page's own marks.
 *
 * ## Why this is still the *same* pipeline
 *
 * The requirement is that drawing works the same way on both surfaces — same tools, same pen,
 * same Ctrl+S, same block you can delete. What differs is only **what the paper is**:
 *
 * | | video | board |
 * |---|---|---|
 * | paper | the captured frame | a blank page at the video's size |
 * | marks | annotations on this frame | this page's marks |
 * | badge | the block's number | **never** — a page has nothing to name |
 * | element pick | yes | no — there is no Studio DOM under the paper |
 *
 * So the marks are painted by `shapePainter.ts`, the same function the live canvas uses, and
 * the only new thing is the background underneath them (found.md F-114, F-128).
 *
 * ## Why the page is the video's size
 *
 * "The page is a temporary blank sheet the same size as the video." That is a product rule,
 * and it is also what makes the two surfaces interchangeable: a stroke drawn at a normalized
 * coordinate lands in the same place after a swap, and the delivered image has the same
 * aspect ratio either way.
 */

import type { AnnotationShape, InkPoint, Point } from "@mystudio/protocol";
import { paintShape } from "./shapePainter.js";

export interface BoardPictureOptions {
  /** Width of the output image, in the composition's design pixels. */
  readonly width: number;
  /** Height of the output image, in the composition's design pixels. */
  readonly height: number;
  /** The page colour, so the sketch reads as paper rather than as a hole. */
  readonly background: string;
  /** The page's marks, in painting order. */
  readonly shapes: readonly AnnotationShape[];
  /** Screen-pixels → image-pixels ratio, applied to stroke width. */
  readonly strokeScale: number;
}

export type BoardPictureResult =
  | { readonly ok: true; readonly pngBase64: string }
  | { readonly ok: false; readonly message: string };

/**
 * Draw the page and return a PNG.
 *
 * `createCanvas` is injected so this can be tested without a DOM; the default uses the
 * browser's own canvas, which is the only thing that can produce the real pixels.
 */
export async function composeBoardPicture(
  options: BoardPictureOptions,
  createCanvas: () => HTMLCanvasElement = defaultCanvas,
): Promise<BoardPictureResult> {
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, message: "The board has no page size" };
  }

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, message: "This browser would not provide a 2D canvas" };

  /*
   * The paper first, then the marks — the same order the live canvas paints, so the delivered
   * picture cannot differ from the page the user was looking at.
   */
  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, width, height);

  const toPixels = (point: Point): Point => ({ x: point.x * width, y: point.y * height });
  const toInkPixels = (point: InkPoint): InkPoint => ({
    x: point.x * width,
    y: point.y * height,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  });

  for (const shape of options.shapes) {
    /*
     * No badge, ever.
     *
     * A page has no prompt, so nothing in the request refers to a shape drawn on it. A number
     * would be an identifier for something that cannot be named — and it would also be a lie:
     * it would claim the mark occupies a slot in a sequence it is not part of (found.md F-076).
     */
    paintShape(ctx, shape, toPixels, toInkPixels, 2.5 * options.strokeScale, null, options.strokeScale);
  }

  try {
    return { ok: true, pngBase64: stripDataUrl(canvas.toDataURL("image/png")) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function defaultCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * A stable description of what a page looks like right now.
 *
 * Same job as `snapshotSignature` for the video: pressing `Ctrl+S` twice with nothing drawn in
 * between must not produce two identical `Drawing N` blocks, while drawing another stroke must
 * produce a new one.
 *
 * A page has no frame and no element selection, so the marks are the whole signature — which
 * makes this simpler than the video's, and also means it cannot drift from it: the two answer
 * different questions about different surfaces.
 */
export function boardSignature(shapes: readonly AnnotationShape[]): string {
  const round = (value: number): string => (Number.isFinite(value) ? value.toFixed(4) : "0");
  return shapes
    .map((shape) => {
      switch (shape.kind) {
        case "freehand": {
          const points = shape.points
            .map((point) => `${round(point.x)},${round(point.y)}`)
            .join(" ");
          return `ink[${shape.colour ?? ""}/${shape.width ?? ""}:${points}]`;
        }
        case "region": {
          const { x, y, width, height } = shape.rect;
          return `box[${round(x)},${round(y)},${round(width)},${round(height)}]`;
        }
        case "arrow":
          return `arrow[${round(shape.from.x)},${round(shape.from.y)}>${round(shape.to.x)},${round(shape.to.y)}]`;
      }
    })
    .join("|");
}
