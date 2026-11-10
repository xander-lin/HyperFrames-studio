import { describe, expect, it } from "vitest";
import { dockDefaultPosition, promptPlacement } from "./promptPlacement.js";

/**
 * Where the prompt box and toolbar go by default.
 *
 * The important rule is not "looks nice": every coordinate is in the **layer's** units,
 * so the viewport passed in must be the layer's viewport (window ÷ scale). A previous
 * version read `window.innerWidth` while the stage had already been divided by the scale,
 * which told a zoomed layer it had more room than the window has.
 */

const stage = { left: 100, top: 80, width: 600, height: 400 };

describe("promptPlacement", () => {
  it("uses the free space to the right of the picture when there is enough", () => {
    const placement = promptPlacement(stage, 1100);
    expect(placement.position.x).toBeGreaterThan(stage.left + stage.width);
    expect(placement.position.y).toBe(Math.max(64, stage.top));
    expect(placement.width).toBeLessThanOrEqual(340);
  });

  it("retreats inside the picture when the right side does not fit", () => {
    // A narrow window: there is no honest room beside the picture, so lower-right it is.
    const placement = promptPlacement(stage, 760);
    expect(placement.position.x).toBeLessThan(stage.left + stage.width);
    expect(placement.position.y).toBeGreaterThan(stage.top);
  });

  it("measures free space against the viewport it is given, not the window", () => {
    /*
     * At 200% zoom the layer only has half the width. The same stage in that coordinate
     * space is twice as wide, so a correct rule sees *less* free space, not more.
     */
    const layerStage = { ...stage, left: 50, width: 300 };
    const wide = promptPlacement(layerStage, 550).position.x;
    const narrow = promptPlacement(layerStage, 500).position.x;
    // Both must stay within the layer viewport they were told about.
    expect(wide).toBeLessThan(550);
    expect(narrow).toBeLessThan(500);
  });

  it("never returns a negative or absurd position before the stage is known", () => {
    const placement = promptPlacement(null, 1280);
    expect(placement.position.x).toBeGreaterThanOrEqual(16);
    expect(placement.position.y).toBeGreaterThan(0);
  });

  it("shrinks to the available width rather than covering half the picture", () => {
    const placement = promptPlacement(stage, 780);
    expect(placement.width).toBeGreaterThanOrEqual(260);
    expect(placement.width).toBeLessThanOrEqual(320);
  });
});

describe("dockDefaultPosition", () => {
  const viewport = { width: 1200, height: 800 };

  it("hugs the right edge of the picture, vertically centred", () => {
    const position = dockDefaultPosition(stage, viewport);
    expect(position.left).toBe(stage.left + stage.width + 6);
    expect(position.top).toBe(Math.round(stage.top + stage.height / 2 - 90));
  });

  it("falls back to the right edge of the window before the stage is measured", () => {
    const position = dockDefaultPosition(null, viewport);
    expect(position.left).toBe(viewport.width - 52 - 6);
    expect(position.top).toBe(Math.round(viewport.height / 2 - 90));
  });

  it("reserves room for the expanded board row so the panel does not hang outside", () => {
    // A wider reserve moves the default leftwards; the caller passes the real width.
    const compact = dockDefaultPosition(null, viewport, 38);
    const expanded = dockDefaultPosition(null, viewport, 104);
    expect(expanded.left).toBeLessThan(compact.left);
  });
});
