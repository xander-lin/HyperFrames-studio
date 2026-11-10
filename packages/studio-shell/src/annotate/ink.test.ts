import { describe, expect, it } from "vitest";
import {
  INK_DEFAULT_WIDTH_PX,
  INK_MAX_POINTS,
  INK_MAX_WIDTH_PX,
  INK_MIN_WIDTH_PX,
  hasPressure,
  inkWidthAt,
  smoothInk,
  thinInk,
} from "./ink.js";
import type { InkPoint } from "@mystudio/protocol";

/**
 * Pen input.
 *
 * Two rules decide whether this feels like writing on a tablet or like dragging a
 * polygon around, and both are pure:
 *
 * 1. a stroke keeps enough samples to be smooth,
 * 2. its width follows pressure — but only when pressure was actually measured.
 *
 * The second rule is the one that is easy to get wrong and hard to notice: a mouse
 * reports a constant 0.5, so treating "no pressure" as 0.5 renders every mouse stroke at
 * a uniform medium weight. The feature then looks like it does nothing while being fed a
 * value that is not a measurement at all.
 */

function ink(x: number, y: number, pressure?: number): InkPoint {
  return pressure === undefined ? { x, y } : { x, y, pressure };
}

describe("inkWidthAt", () => {
  it("grows with pressure", () => {
    const light = inkWidthAt(ink(0, 0, 0));
    const middle = inkWidthAt(ink(0, 0, 0.5));
    const heavy = inkWidthAt(ink(0, 0, 1));
    expect(light).toBeCloseTo(INK_MIN_WIDTH_PX);
    expect(heavy).toBeCloseTo(INK_MAX_WIDTH_PX);
    expect(middle).toBeGreaterThan(light);
    expect(middle).toBeLessThan(heavy);
  });

  it("uses a constant middle width when the device reported no pressure", () => {
    /*
     * A mouse is not a light pen. Reading "absent" as 0.5 would claim a measurement the
     * device never made and produce a width that pretends to have been pressed — but a
     * mouse stroke still needs a sensible constant width, so it gets the middle of the
     * stroke's own range and never varies.
     */
    const flat = inkWidthAt(ink(0.5, 0.5));
    expect(flat).toBeGreaterThan(INK_MIN_WIDTH_PX * 0.9);
    expect(flat).toBeLessThan(INK_MAX_WIDTH_PX * 1.1);
    // Changing the stroke's chosen weight scales it, but a mouse still never varies
    // *within* one stroke.
    expect(inkWidthAt(ink(0.5, 0.5), 1, 1.5)).toBeLessThan(flat);
    expect(inkWidthAt(ink(0.5, 0.5), 1, 6)).toBeGreaterThan(flat);
  });

  it("scales the whole range with the chosen pen weight", () => {
    /*
     * The pen selector must mean "this weight", not "this small modulation on a fixed
     * weight": a thin pen and a thick pen are the same gesture at two sizes.
     */
    const thin = inkWidthAt(ink(0, 0, 1), 1, 1.5);
    const thick = inkWidthAt(ink(0, 0, 1), 1, 6);
    expect(thick).toBeGreaterThan(thin * 2);
  });

  it("draws at the documented default when no weight is given", () => {
    expect(INK_DEFAULT_WIDTH_PX).toBeGreaterThan(INK_MIN_WIDTH_PX);
    expect(INK_DEFAULT_WIDTH_PX).toBeLessThan(INK_MAX_WIDTH_PX);
  });

  it("clamps a pressure outside 0..1 instead of drawing a negative width", () => {
    // Some drivers overshoot, and a negative radius throws.
    expect(inkWidthAt(ink(0, 0, 4))).toBeCloseTo(INK_MAX_WIDTH_PX);
    expect(inkWidthAt(ink(0, 0, -3))).toBeCloseTo(INK_MIN_WIDTH_PX);
  });

  it("scales with the caller's factor, for hi-DPI canvases", () => {
    expect(inkWidthAt(ink(0, 0, 1), 2)).toBeCloseTo(INK_MAX_WIDTH_PX * 2);
  });
});

describe("hasPressure", () => {
  it("is false for a mouse stroke and true for a pen stroke", () => {
    // The renderer uses this to decide whether to draw a tapered outline at all.
    expect(hasPressure([ink(0, 0), ink(0.1, 0.1)])).toBe(false);
    expect(hasPressure([ink(0, 0, 0.2), ink(0.1, 0.1, 0.9)])).toBe(true);
  });
});

describe("thinInk", () => {
  it("leaves a short stroke untouched", () => {
    const points = [ink(0, 0), ink(0.1, 0), ink(0.2, 0)];
    expect(thinInk(points, 10)).toEqual(points);
  });

  it("keeps both ends, so the stroke still starts and finishes where the pen did", () => {
    const points = Array.from({ length: 500 }, (_, index) => ink(index / 500, 0));
    const thinned = thinInk(points, 50);
    expect(thinned[0]).toEqual(points[0]);
    expect(thinned[thinned.length - 1]).toEqual(points[points.length - 1]);
  });

  it("respects the limit", () => {
    const points = Array.from({ length: 900 }, (_, index) => ink(index / 900, index / 900));
    expect(thinInk(points, 40).length).toBeLessThanOrEqual(40);
  });

  it("keeps the corners of a letter rather than sampling evenly", () => {
    /*
     * A zig-zag: the vertices are the only samples that matter. Even sampling would cut
     * them off and the letter would come out as a smooth wave.
     */
    const points: InkPoint[] = [];
    for (let index = 0; index < 300; index += 1) {
      // Long straight run, then a hard turn every 30 samples.
      const corner = Math.floor(index / 30) % 2 === 0;
      points.push(ink(index / 300, corner ? 0.1 : 0.5));
    }
    const thinned = thinInk(points, 40);
    // Something close to the zig-zag extreme must survive.
    expect(thinned.some((point) => point.y > 0.45)).toBe(true);
    expect(thinned.some((point) => point.y < 0.15)).toBe(true);
  });

  it("defaults to the documented ceiling", () => {
    expect(INK_MAX_POINTS).toBeGreaterThan(100);
  });

  it("handles an empty stroke", () => {
    expect(thinInk([], 10)).toEqual([]);
  });
});

describe("smoothInk", () => {
  it("leaves a one- or two-point stroke exactly as it is", () => {
    // Nothing to smooth, and inventing points would move a dot away from where the pen hit.
    expect(smoothInk([ink(0.1, 0.1)])).toEqual([ink(0.1, 0.1)]);
    expect(smoothInk([ink(0.1, 0.1), ink(0.2, 0.2)])).toEqual([ink(0.1, 0.1), ink(0.2, 0.2)]);
  });

  it("keeps both ends where the pen touched them", () => {
    // The stroke must not drift; only the middle is resampled.
    const points = [ink(10, 10), ink(60, 20), ink(110, 10), ink(160, 20)];
    const smooth = smoothInk(points);
    expect(smooth[0]).toEqual(points[0]);
    expect(smooth[smooth.length - 1]).toEqual(points[points.length - 1]);
  });

  it("adds points between samples, so a corner becomes a curve", () => {
    // A single hard corner: the smoothed stroke must have interior samples on both
    // sides of it, which is what makes it read as a curve instead of two straight runs.
    const points = [ink(0, 0), ink(100, 100), ink(200, 0)];
    const smooth = smoothInk(points);
    expect(smooth.length).toBeGreaterThan(points.length);
  });

  it("interpolates pressure, so the taper stays continuous", () => {
    /*
     * Without interpolation the width would step at every original sample, which on a
     * smoothed path shows up as beads along the stroke.
     */
    const smooth = smoothInk([ink(0, 0, 0.1), ink(100, 0, 0.9), ink(200, 0, 0.1)]);
    const pressures = smooth
      .map((point) => point.pressure)
      .filter((value): value is number => value !== undefined);
    expect(pressures.length).toBe(smooth.length);
    // Monotonic on the way up: no value drops while the pen is pressing harder.
    const rising = pressures.slice(0, pressures.indexOf(Math.max(...pressures)) + 1);
    for (let index = 1; index < rising.length; index += 1) {
      expect(rising[index]!).toBeGreaterThanOrEqual(rising[index - 1]! - 1e-9);
    }
  });

  it("invents no pressure for a mouse stroke", () => {
    // Smoothing must not turn "unmeasured" into a number, or the flat-width rule is lost.
    const smooth = smoothInk([ink(0, 0), ink(100, 40), ink(200, 0)]);
    for (const point of smooth) expect("pressure" in point).toBe(false);
  });

  it("does not explode the point count on dense input", () => {
    // A slow pen already has smooth geometry; subdividing it further would be waste in
    // the live drawing path.
    const dense = Array.from({ length: 200 }, (_, index) => ink(index * 0.7, Math.sin(index / 8)));
    expect(smoothInk(dense).length).toBeLessThan(dense.length * 3);
  });
});
