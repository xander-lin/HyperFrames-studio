import { describe, expect, it } from "vitest";
import { clampPanelBox, type PanelBox } from "./floatingPanelBox.js";

/**
 * The floating panel's box, clamped to the window.
 *
 * This imports the **real** rule from `floatingPanelBox.ts`. It used to re-implement the
 * arithmetic next to the component, which meant it kept passing while the component could
 * drift — a test of the copy, not of the product.
 *
 * What it pins is the rule that broke at the app's minimum window size: **a panel must be
 * usable in the window it is in**, not merely "mostly on screen". The old rule kept a
 * 120px sliver and let the rest hang outside; once the window could be 420×340, the prompt
 * box put its send button outside the window and could not be reached at all.
 */

const clampBox = (box: PanelBox, vw: number, vh: number): PanelBox =>
  clampPanelBox(box, { width: vw, height: vh });

const inside = (box: PanelBox, vw: number, vh: number) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= vw && box.y + box.height <= vh;

describe("floating panel stays inside the window", () => {
  it("keeps a comfortable panel exactly where it was put", () => {
    const box = { x: 300, y: 200, width: 300, height: 260 };
    expect(clampBox(box, 1100, 1000)).toEqual(box);
  });

  it("shrinks rather than hanging outside a small window", () => {
    // The reported failure: the prompt box at its stored size, in a 420×340 window.
    // It must be *inside*, which the old rule (keep a 120px sliver) did not guarantee.
    const box = clampBox({ x: 300, y: 230, width: 297, height: 500 }, 420, 340);
    expect(inside(box, 420, 340)).toBe(true);
    expect(box.height).toBeLessThan(500);
  });

  it("works at every size the window can take", () => {
    for (const [vw, vh] of [
      [1100, 1000],
      [820, 540],
      [700, 480],
      [640, 420],
      [520, 380],
      [420, 340],
    ] as const) {
      const box = clampBox({ x: 9999, y: 9999, width: 400, height: 400 }, vw, vh);
      expect(inside(box, vw, vh)).toBe(true);
      // And still big enough to be worth showing.
      expect(box.width).toBeGreaterThanOrEqual(120);
      expect(box.height).toBeGreaterThanOrEqual(80);
    }
  });

  it("pulls a stale far-off position back into view", () => {
    // Positions are persisted; a smaller window must not reopen the panel off-screen.
    const box = clampBox({ x: 1400, y: 900, width: 300, height: 260 }, 700, 480);
    expect(inside(box, 700, 480)).toBe(true);
  });

  it("does not let the minimum size re-create the overflow it was meant to prevent", () => {
    /*
     * A 240px minimum width in a 200px window would put 40px outside. The minimum is
     * therefore conditional on there being room for it.
     */
    const box = clampBox({ x: 10, y: 10, width: 300, height: 300 }, 200, 200);
    expect(inside(box, 200, 200)).toBe(true);
  });
});
