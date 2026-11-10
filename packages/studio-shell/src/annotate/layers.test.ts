import { describe, expect, it } from "vitest";
import { ANNOTATION_LAYERS, DOCKVIEW_SASH_Z_INDEX, allLayersAboveSash } from "./layers.js";

/**
 * Stacking order.
 *
 * Background (found.md F-033): dockview hard-codes `z-index: 99` on its sash
 * `.dv-sash`. Our layers used scattered numbers like 35/40/60/71, all below it, so
 * the toolbar was **visible but unclickable** — the pointer was swallowed by the
 * sash. Nothing errors in that situation, so only a test can pin down the rule
 * "must stay above the sash".
 */
describe("annotation layers", () => {
  it("keeps every layer above dockview's sash, or the UI becomes untouchable", () => {
    expect(allLayersAboveSash()).toBe(true);
  });

  it("puts the shield below the canvas, so drawing still works", () => {
    // A shield above the canvas eats every pointer meant for the canvas, and nothing
    // can be drawn at all.
    expect(ANNOTATION_LAYERS.shield).toBeLessThan(ANNOTATION_LAYERS.canvas);
  });

  it("puts the dock above the canvas so its controls stay clickable while annotating", () => {
    expect(ANNOTATION_LAYERS.dock).toBeGreaterThan(ANNOTATION_LAYERS.canvas);
  });

  it("keeps the prompt panel and property float above the dock", () => {
    // Panels get dragged next to the toolbar; below it, the covered part cannot be clicked.
    expect(ANNOTATION_LAYERS.panel).toBeGreaterThan(ANNOTATION_LAYERS.dock);
  });

  it("keeps the sprite on top of everything", () => {
    const others = Object.entries(ANNOTATION_LAYERS)
      .filter(([name]) => name !== "sprite")
      .map(([, value]) => value);
    for (const value of others) expect(ANNOTATION_LAYERS.sprite).toBeGreaterThan(value);
  });

  it("leaves gaps between layers instead of consecutive numbers", () => {
    // Consecutive numbers look like they leave room to insert one, but lead the next
    // person to pick a colliding value.
    const values = Object.values(ANNOTATION_LAYERS).slice().sort((a, b) => a - b);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]! - values[i - 1]!).toBeGreaterThanOrEqual(5);
    }
  });

  it("records the sash level we must stay above", () => {
    expect(DOCKVIEW_SASH_Z_INDEX).toBe(99);
    expect(Math.min(...Object.values(ANNOTATION_LAYERS))).toBeGreaterThan(DOCKVIEW_SASH_Z_INDEX);
  });
});
