/**
 * Rendering handwriting.
 *
 * A pen stroke is not a polyline. Drawing one as `lineTo` between pointer samples
 * produces the two defects that make tablet input feel broken: the line is visibly
 * made of straight segments, and it has one constant width even though a real pen
 * presses harder and softer within a single word.
 *
 * So this module does what a note-taking app does, in three steps:
 *
 * 1. **Smooth the path.** A quadratic curve through the midpoints of consecutive
 *    samples. The curve never has a corner at a sample, which is what the eye reads as
 *    "smooth"; the samples themselves stay the control points, so the stroke still goes
 *    exactly where the pen went.
 * 2. **Vary the width.** Width follows pressure along the stroke, interpolated per
 *    segment rather than per sample, so the thickness changes gradually instead of in
 *    visible steps.
 * 3. **Draw as a filled outline.** A variable-width line cannot be produced by
 *    `ctx.stroke`: the line width is one number for the whole path. Instead each
 *    segment contributes a quadrilateral (plus a round cap where the direction changes
 *    sharply) and the union is filled in one colour — which also means overlapping
 *    segments do not darken each other into a beaded line.
 *
 * Pure and DOM-free apart from the canvas context passed in, so the geometry rules —
 * pressure to width, and the "a mouse is not a light pen" rule — are testable.
 */

import type { InkPoint } from "@mystudio/protocol";

/**
 * Width of a stroke at pressure 0 and at pressure 1, in CSS pixels, before the
 * caller's own scale factor.
 *
 * The ratio is what makes handwriting legible: too narrow and thin strokes disappear
 * over busy footage, too wide and the difference between a light and a heavy hand
 * stops being visible.
 */
export const INK_MIN_WIDTH_PX = 1.2;
export const INK_MAX_WIDTH_PX = 4.6;

/**
 * How many samples a stroke may store before it is thinned.
 *
 * A fast digitizer emits a sample per millisecond; a two-second stroke would then carry
 * two thousand points into the protocol, the prompt bundle and every re-render. The
 * limit is high enough that no hand-drawn line looks angular at any zoom the app
 * supports.
 */
export const INK_MAX_POINTS = 1200;

/** The width a stroke is drawn with when the caller names none. */
export const INK_DEFAULT_WIDTH_PX = 3;

/**
 * Width in pixels for one sample.
 *
 * `pressure` absent means "the device cannot measure it" — a mouse, or a synthetic
 * event. That is **not** the same as pressure 0.5, and treating it as such is the
 * classic mistake: every mouse stroke then renders at the middle of the range, which
 * looks like a heavy hand and never varies, so the feature appears not to work while
 * actually being fed a constant.
 *
 * `base` is the stroke's own chosen weight (the pen selector in the toolbar). Pressure
 * modulates around it rather than replacing it, so a "thin pen" and a "thick pen" are the
 * same gesture at two weights — which is what a pen selector is supposed to mean.
 */
export function inkWidthAt(
  point: InkPoint,
  scale = 1,
  base = INK_DEFAULT_WIDTH_PX,
): number {
  // The range widens with the chosen weight, keeping the taper visible at every size.
  const min = base * (INK_MIN_WIDTH_PX / INK_DEFAULT_WIDTH_PX);
  const max = base * (INK_MAX_WIDTH_PX / INK_DEFAULT_WIDTH_PX);
  const pressure = point.pressure;
  if (pressure === undefined) {
    // A mouse gets the middle of this stroke's own range, constant.
    return ((min + max) / 2) * scale;
  }
  const clamped = Math.min(1, Math.max(0, pressure));
  return (min + (max - min) * clamped) * scale;
}

/** Whether the stored stroke carries real pressure measurements anywhere. */
export function hasPressure(points: readonly InkPoint[]): boolean {
  return points.some((point) => point.pressure !== undefined);
}

/**
 * Reduce a stroke to at most `limit` samples by dropping the least informative ones.
 *
 * Uniform decimation would cut corners off letters. Instead this keeps every sample
 * whose direction differs from the running direction by more than a small angle — the
 * corners of a letter — and drops the ones in the middle of a straight run, which carry
 * no information the neighbours do not.
 */
export function thinInk(points: readonly InkPoint[], limit = INK_MAX_POINTS): InkPoint[] {
  if (points.length <= limit) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];

  const corners: InkPoint[] = [first];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!previous || !current || !next) continue;
    if (angleBetween(previous, current, next) > 0.12) corners.push(current);
  }
  corners.push(last);

  if (corners.length <= limit) return corners;

  // Still too many: fall back to even sampling, always keeping both ends so the stroke
  // starts and finishes where the pen did.
  const step = (corners.length - 1) / (limit - 1);
  const sampled: InkPoint[] = [];
  for (let index = 0; index < limit; index += 1) {
    const source = corners[Math.round(index * step)];
    if (source) sampled.push(source);
  }
  return sampled;
}

/** Turn an angle between two segments into a value where 0 is straight and π is a fold. */
function angleBetween(a: InkPoint, b: InkPoint, c: InkPoint): number {
  const first = Math.atan2(b.y - a.y, b.x - a.x);
  const second = Math.atan2(c.y - b.y, c.x - b.x);
  let delta = Math.abs(second - first);
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  return delta;
}

/**
 * Resample a stroke along quadratic curves so it reads as smooth handwriting.
 *
 * ## The problem this solves
 *
 * Pointer samples arrive as points; drawing `lineTo` between them produces a line made
 * of visible straight segments, with a corner at every sample. That is the single most
 * recognisable difference between "a tablet app" and "dragging a polygon around", and no
 * amount of extra samples fixes it on its own — the corners are still there, only
 * smaller.
 *
 * ## The curve
 *
 * Each interior sample is the **control point** of a quadratic curve that runs from the
 * midpoint before it to the midpoint after it. This is the classic trick: the curve never
 * touches the control point, so it cannot overshoot, and consecutive curves meet exactly
 * at a midpoint with matching direction — which is precisely what "no corners" means.
 * The first and last samples are kept verbatim, so the stroke still starts and finishes
 * where the pen did.
 *
 * ## How much subdivision
 *
 * Proportional to segment length, capped: a long segment between two fast samples is
 * where the corner would show, so it gets the most interpolation. A stroke that is
 * already dense (a slow pen, or coalesced samples) is left almost as it is, so live
 * drawing does not pay for smoothness it already has.
 */
export function smoothInk(points: readonly InkPoint[]): InkPoint[] {
  if (points.length < 3) return [...points];

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];

  const result: InkPoint[] = [first];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (!current || !next) continue;

    const start = index === 0 ? current : midpoint(points[index - 1] ?? current, current);
    const end = index === points.length - 2 ? next : midpoint(current, points[index + 1] ?? next);

    const steps = subdivisions(start, end);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push(quadraticAt(start, current, end, t, pressureBetween(start, end, t)));
    }
  }

  return result;
}

/** Interpolated midpoint, keeping whichever pressure the two samples agree on. */
function midpoint(a: InkPoint, b: InkPoint): InkPoint {
  const point: InkPoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const pressure = meanPressure(a, b);
  return pressure === undefined ? point : { ...point, pressure };
}

/** Pressure at a fraction `t` along a segment, or absent when neither end measured it. */
function pressureBetween(a: InkPoint, b: InkPoint, t: number): number | undefined {
  if (a.pressure === undefined && b.pressure === undefined) return undefined;
  const first = a.pressure ?? b.pressure ?? 0.5;
  const second = b.pressure ?? a.pressure ?? 0.5;
  return first + (second - first) * t;
}

function meanPressure(a: InkPoint, b: InkPoint): number | undefined {
  if (a.pressure === undefined && b.pressure === undefined) return undefined;
  const first = a.pressure ?? b.pressure ?? 0.5;
  const second = b.pressure ?? a.pressure ?? 0.5;
  return (first + second) / 2;
}

/**
 * How many pieces to cut one segment into.
 *
 * Below roughly four pixels a straight piece is indistinguishable from a curve at any
 * zoom the app offers, so dense input is passed through unchanged.
 */
function subdivisions(a: InkPoint, b: InkPoint): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 4) return 1;
  return Math.min(8, Math.max(2, Math.round(length / 4)));
}

/** One point on a quadratic Bézier. */
function quadraticAt(
  start: InkPoint,
  control: InkPoint,
  end: InkPoint,
  t: number,
  pressure: number | undefined,
): InkPoint {
  const inv = 1 - t;
  const x = inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x;
  const y = inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y;
  return pressure === undefined ? { x, y } : { x, y, pressure };
}

/**
 * Paint one stroke.
 *
 * `points` are already in **canvas pixels**; the caller converts from normalized
 * coordinates so that stroke width stays a screen-space property. Width should not
 * scale with the composition: a 4K preview and a 720p preview must look like the same
 * pen made the same mark.
 */
export function paintInk(
  ctx: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  options: { colour: string; scale?: number; width?: number },
): void {
  const ink = smoothInk(thinInk(points));
  if (ink.length === 0) return;

  const scale = options.scale ?? 1;
  const base = options.width ?? INK_DEFAULT_WIDTH_PX;

  // A single sample is a dot: the pen touched the surface. Without this the user sees
  // nothing at all after a tap.
  if (ink.length === 1) {
    const only = ink[0];
    if (!only) return;
    const width = inkWidthAt(only, scale, base);
    ctx.beginPath();
    ctx.arc(only.x, only.y, width / 2, 0, Math.PI * 2);
    ctx.fillStyle = options.colour;
    ctx.fill();
    return;
  }

  ctx.fillStyle = options.colour;

  for (let index = 0; index < ink.length - 1; index += 1) {
    const from = ink[index];
    const to = ink[index + 1];
    if (!from || !to) continue;
    segmentQuad(ctx, from, to, options.colour, scale, base);

    // Join: a circle at the inner sample covers the wedge a direction change leaves
    // open. Without it, sharp letters show a notch at every corner.
    if (index > 0) {
      const radius = inkWidthAt(from, scale, base) / 2;
      ctx.beginPath();
      ctx.arc(from.x, from.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Round the final end so the stroke does not finish with a square cut.
  const end = ink[ink.length - 1];
  if (end) {
    ctx.beginPath();
    ctx.arc(end.x, end.y, inkWidthAt(end, scale, base) / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** One segment as a filled trapezoid, its ends widened to each sample's own width. */
function segmentQuad(
  ctx: CanvasRenderingContext2D,
  from: InkPoint,
  to: InkPoint,
  colour: string,
  scale: number,
  base: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const nx = -dy / length;
  const ny = dx / length;
  const fromRadius = inkWidthAt(from, scale, base) / 2;
  const toRadius = inkWidthAt(to, scale, base) / 2;

  ctx.beginPath();
  ctx.moveTo(from.x + nx * fromRadius, from.y + ny * fromRadius);
  ctx.lineTo(to.x + nx * toRadius, to.y + ny * toRadius);
  ctx.lineTo(to.x - nx * toRadius, to.y - ny * toRadius);
  ctx.lineTo(from.x - nx * fromRadius, from.y - ny * fromRadius);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}
