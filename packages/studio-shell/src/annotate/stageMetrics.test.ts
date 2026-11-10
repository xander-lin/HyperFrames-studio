import { describe, expect, it } from "vitest";
import { measureStage, sameStageRect } from "./stageMetrics.js";

/**
 * The two facts the annotation layer needs about the picture: where it is, and whether it
 * moved. Both are compared with tolerance, because a sub-pixel difference is not a move —
 * rebuilding the whole annotation UI for it looks like flickering.
 */

describe("sameStageRect", () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };

  it("treats the same values as unchanged", () => {
    expect(sameStageRect(rect, { ...rect })).toBe(true);
  });

  it("ignores sub-pixel drift", () => {
    expect(sameStageRect(rect, { ...rect, left: 100.4, width: 640.3 })).toBe(true);
  });

  it("notices a real move or resize", () => {
    expect(sameStageRect(rect, { ...rect, left: 101 })).toBe(false);
    expect(sameStageRect(rect, { ...rect, width: 641 })).toBe(false);
  });

  it("distinguishes 'not measured yet' from any rect", () => {
    expect(sameStageRect(null, null)).toBe(true);
    expect(sameStageRect(null, rect)).toBe(false);
    expect(sameStageRect(rect, null)).toBe(false);
  });
});

describe("measureStage", () => {
  it("returns null while the iframe is not mounted", () => {
    expect(measureStage(null)).toBeNull();
  });

  it("returns null for a disconnected iframe, even if it has a stale rect", () => {
    expect(
      measureStage({
        isConnected: false,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
      }),
    ).toBeNull();
  });

  it("returns null when the iframe has no area", () => {
    expect(
      measureStage({
        isConnected: true,
        getBoundingClientRect: () => ({ left: 10, top: 10, width: 0, height: 0 }),
      }),
    ).toBeNull();
  });

  it("converts a DOMRect into the plain rect annotations are normalised against", () => {
    expect(
      measureStage({
        isConnected: true,
        // A DOMRect carries fields the layer does not need; only the four matter.
        getBoundingClientRect: () => ({ left: 12, top: 34, width: 640, height: 360, x: 12, y: 34, right: 652, bottom: 394 }),
      }),
    ).toEqual({ left: 12, top: 34, width: 640, height: 360 });
  });
});
