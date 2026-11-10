/**
 * Painting an annotation shape onto a canvas: **one implementation, two users**.
 *
 * The live canvas and the composed capture must produce the same picture. Splitting them was
 * the defect behind "截图的时候，什么箭头、选区框全都看不见": the capture composer accepted
 * only handwriting, so an arrow or a region — which the user clearly sees on screen — simply
 * was not drawn into the delivered image (found.md F-110).
 *
 * What the user sees is what the reader must see. So the drawing code lives here, takes a
 * coordinate mapping, and both callers hand it one.
 */

import type { AnnotationShape, InkPoint, Point } from "@mystudio/protocol";
import { paintInk } from "./ink.js";

/** High-contrast stroke colour: readable on both dark and light footage. */
export const STROKE = "#ff3b30";
export const STROKE_HALO = "rgba(0,0,0,0.55)";

/** Line width for shapes, in canvas pixels. */
export const SHAPE_LINE_WIDTH = 2.5;

/**
 * Draw a numbered badge.
 *
 * Position: just outside the shape's top-left corner so it never covers the shape.
 * Look: solid red with white text, same family as the stroke, legible on any background.
 */
export function drawBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale = 1,
): void {
  const radius = 8 * scale;
  const cx = x - 2 * scale;
  const cy = y - 2 * scale;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = STROKE;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(1, scale);
  ctx.stroke();

  ctx.fillStyle = "#fff";
  ctx.font = `600 ${10 * scale}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 0.5 * scale);
  ctx.restore();
}

/**
 * Paint one finished shape.
 *
 * `toPixels` maps a normalized point into output pixels; `toInkPixels` does the same while
 * carrying pressure. `badge` is the ordinal to draw, or `null` for none — a board page and a
 * composed capture carry no numbers.
 */
export function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: AnnotationShape,
  toPixels: (point: Point) => Point,
  toInkPixels: (point: InkPoint) => InkPoint,
  lineWidth: number,
  badge: string | null,
  /** Scale factor for badges (the capture is at composition resolution, not screen). */
  badgeScale = 1,
): void {
  if (shape.kind === "region") {
    const a = toPixels({ x: shape.rect.x, y: shape.rect.y });
    const b = toPixels({ x: shape.rect.x + shape.rect.width, y: shape.rect.y + shape.rect.height });
    ctx.save();
    ctx.strokeStyle = STROKE_HALO;
    ctx.lineWidth = lineWidth + 4;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillStyle = "rgba(255,59,48,0.10)";
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
    if (badge) drawBadge(ctx, badge, a.x, a.y, badgeScale);
    return;
  }

  if (shape.kind === "arrow") {
    drawArrow(ctx, toPixels(shape.from), toPixels(shape.to), lineWidth);
    // The number goes at the tail, so it does not sit on the shaft.
    if (badge) {
      const tail = toPixels(shape.from);
      drawBadge(ctx, badge, tail.x, tail.y, badgeScale);
    }
    return;
  }

  /*
   * Ink is painted, not labelled: a stroke's meaning is its shape, and a number floating
   * beside a scribble only gives the eye something to resolve. The halo is a thicker pass
   * underneath, which keeps white-on-white writing legible without changing the ink colour.
   */
  const points = shape.points.map(toInkPixels);
  /*
   * `badgeScale` carries the screen-to-composition ratio, and ink must use it too.
   *
   * Width is stored in **screen** pixels (that is what makes a stroke look the same on any
   * preview size), so drawing at composition resolution without this factor produced a
   * 3px line on a 1920px-wide image — technically present, visually invisible. That is why
   * the delivered picture looked like it had `no strokes at all` while the canvas clearly
   * showed them (found.md F-112).
   */
  paintInk(ctx, points, { colour: STROKE_HALO, scale: badgeScale * 1.9, width: shape.width });
  paintInk(ctx, points, { colour: shape.colour ?? STROKE, scale: badgeScale, width: shape.width });
}

/**
 * Draw a line with a halo.
 *
 * The halo (a thick dark line under a thin red one) keeps it visible on any background —
 * footage may be pure white or pure black, and a single colour always disappears somewhere.
 */
export function strokePath(
  ctx: CanvasRenderingContext2D,
  path: readonly Point[],
  width: number,
): void {
  if (path.length === 0) return;
  const [first, ...rest] = path;
  if (!first) return;

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = STROKE_HALO;
  ctx.lineWidth = width + 4;
  ctx.stroke();

  ctx.strokeStyle = STROKE;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** A line with an arrow head at `to`. */
export function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  width: number,
): void {
  strokePath(ctx, [from, to], width);

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = Math.max(12, width * 4);
  const spread = Math.PI / 7;
  const left = {
    x: to.x - headLength * Math.cos(angle - spread),
    y: to.y - headLength * Math.sin(angle - spread),
  };
  const right = {
    x: to.x - headLength * Math.cos(angle + spread),
    y: to.y - headLength * Math.sin(angle + spread),
  };
  strokePath(ctx, [left, to, right], width);
}
