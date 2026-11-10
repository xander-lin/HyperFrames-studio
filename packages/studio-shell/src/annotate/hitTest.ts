/**
 * Hit testing for the eraser.
 *
 * The eraser asks one question: "did this pointer touch that mark?" A bounding-box
 * test would answer "yes" for two arrows crossing the same area even when the click
 * landed in the gap between them, which feels arbitrary. So each kind is tested
 * against its own geometry:
 *
 * - **region** — inside the rectangle, plus a tolerance band;
 * - **arrow** — distance to the shaft segment, clamped to the segment so the empty
 *   space beyond the arrow head does not count;
 * - **freehand** — distance to any segment of the polyline.
 *
 * All coordinates are normalized (0..1), so `tolerance` is normalized too. The
 * caller converts a pixel tolerance through the stage size.
 */

import type { AnnotationShape, Point } from "@mystudio/protocol";

/** Distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Distance from a point to a line segment.
 *
 * Clamped to the segment: an arrow's "nearness" must not extend past its head,
 * otherwise clicking empty space beyond the tip erases the arrow.
 */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, a);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Whether a mark passes through (or within `tolerance` of) a point. */
export function shapeContains(shape: AnnotationShape, point: Point, tolerance: number): boolean {
  switch (shape.kind) {
    case "region":
      return (
        point.x >= shape.rect.x - tolerance &&
        point.x <= shape.rect.x + shape.rect.width + tolerance &&
        point.y >= shape.rect.y - tolerance &&
        point.y <= shape.rect.y + shape.rect.height + tolerance
      );
    case "arrow":
      return distanceToSegment(point, shape.from, shape.to) <= tolerance;
    case "freehand": {
      const points = shape.points;
      for (let index = 0; index < points.length - 1; index += 1) {
        const a = points[index];
        const b = points[index + 1];
        if (!a || !b) continue;
        if (distanceToSegment(point, a, b) <= tolerance) return true;
      }
      // A one-point stroke still has a place on the frame.
      const only = points[0];
      return only ? distance(point, only) <= tolerance : false;
    }
  }
}
