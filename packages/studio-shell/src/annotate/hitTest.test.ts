import { describe, expect, it } from "vitest";
import { distance, distanceToSegment, shapeContains } from "./hitTest.js";

/**
 * Eraser hit testing.
 *
 * What matters is that the eraser hits what the user aimed at and nothing else. A
 * bounding-box test would erase two crossing arrows when the click landed in the gap
 * between them, which feels arbitrary, so each shape is tested against its own
 * geometry.
 */

const TOLERANCE = 0.02;

describe("distanceToSegment", () => {
  it("measures perpendicular distance to the shaft", () => {
    expect(distanceToSegment({ x: 0.5, y: 0.1 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0.1);
  });

  it("clamps to the segment, so points past the end measure to the end", () => {
    // Beyond the head, the nearest point is the head itself — that is why clicking
    // empty space past an arrow does not erase it.
    expect(distanceToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(1);
  });

  it("handles a zero-length segment without dividing by zero", () => {
    expect(distanceToSegment({ x: 0.3, y: 0.4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(0.5);
  });
});

describe("distance", () => {
  it("is the plain Euclidean distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe("shapeContains — region", () => {
  const region = { kind: "region" as const, rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } };

  it("accepts a point inside the rectangle", () => {
    expect(shapeContains(region, { x: 0.3, y: 0.3 }, TOLERANCE)).toBe(true);
  });

  it("accepts a point just outside, within the tolerance band", () => {
    expect(shapeContains(region, { x: 0.51, y: 0.3 }, TOLERANCE)).toBe(true);
  });

  it("rejects a point well outside", () => {
    expect(shapeContains(region, { x: 0.8, y: 0.8 }, TOLERANCE)).toBe(false);
  });
});

describe("shapeContains — arrow", () => {
  const arrow = { kind: "arrow" as const, from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.2 } };

  it("accepts a point on the shaft", () => {
    expect(shapeContains(arrow, { x: 0.4, y: 0.2 }, TOLERANCE)).toBe(true);
  });

  it("accepts a point near the shaft", () => {
    expect(shapeContains(arrow, { x: 0.4, y: 0.21 }, TOLERANCE)).toBe(true);
  });

  it("rejects a point past the head, in empty space", () => {
    expect(shapeContains(arrow, { x: 0.9, y: 0.2 }, TOLERANCE)).toBe(false);
  });

  it("rejects a point beside the middle, outside the tolerance", () => {
    expect(shapeContains(arrow, { x: 0.4, y: 0.4 }, TOLERANCE)).toBe(false);
  });
});

describe("shapeContains — freehand", () => {
  const stroke = {
    kind: "freehand" as const,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.5 },
    ],
  };

  it("accepts a point on any segment of the polyline", () => {
    expect(shapeContains(stroke, { x: 0.25, y: 0.1 }, TOLERANCE)).toBe(true);
    // The second segment turns a corner; a bounding box would answer "yes" here for
    // the wrong reason, so this is checked against the geometry.
    expect(shapeContains(stroke, { x: 0.4, y: 0.3 }, TOLERANCE)).toBe(true);
  });

  it("rejects a point inside the bounding box but far from the stroke", () => {
    // (0.15, 0.45) is inside the box spanned by the points, yet nowhere near a line.
    expect(shapeContains(stroke, { x: 0.15, y: 0.45 }, TOLERANCE)).toBe(false);
  });

  it("handles a one-point stroke", () => {
    const dot = { kind: "freehand" as const, points: [{ x: 0.5, y: 0.5 }] };
    expect(shapeContains(dot, { x: 0.5, y: 0.5 }, TOLERANCE)).toBe(true);
    expect(shapeContains(dot, { x: 0.9, y: 0.9 }, TOLERANCE)).toBe(false);
  });
});
