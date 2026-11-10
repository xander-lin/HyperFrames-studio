import { describe, expect, it } from "vitest";
import { cursorForShield, cursorForTool } from "./cursors.js";
import type { AnnotationTool } from "./editorState.js";

/**
 * What the pointer looks like per tool.
 *
 * The reported defect: **every** tool showed a crosshair, including over empty margins. Two
 * separate causes, and the test has to pin both:
 *
 * 1. the canvas gave one cursor for four different gestures;
 * 2. the input shield — a full-viewport layer — also declared a crosshair, so its choice
 *    covered the whole window and the canvas's rarely showed.
 *
 * A cursor is the only feedback before the first stroke, so "which gesture will this press
 * start" has to be answerable from it.
 */

const DRAWING_TOOLS: readonly AnnotationTool[] = ["region", "arrow", "freehand", "eraser"];

describe("cursorForTool", () => {
  it("distinguishes the drawing tools from each other", () => {
    /*
     * The regression in one assertion: a pen, an arrow, a box and an eraser must not all
     * answer the same string, or the user cannot tell what is armed.
     */
    const cursors = DRAWING_TOOLS.map((tool) => cursorForTool(tool));
    expect(new Set(cursors).size).toBe(DRAWING_TOOLS.length);
  });

  it("shows a box cursor while the region tool is armed", () => {
    // A rectangular selection is the one case where a crosshair is the honest symbol.
    expect(cursorForTool("region")).toBe("crosshair");
  });

  it("shows a pen for freehand, not a crosshair", () => {
    expect(cursorForTool("freehand")).not.toBe("crosshair");
    expect(cursorForTool("freehand")).toContain("svg");
  });

  it("shows an arrow for the arrow tool", () => {
    expect(cursorForTool("arrow")).toContain("svg");
    expect(cursorForTool("arrow")).not.toBe(cursorForTool("freehand"));
  });

  it("shows a ring for the eraser, because it erases an area", () => {
    // The eraser is a hit test with a tolerance; a ring is a picture of that reach.
    expect(cursorForTool("eraser")).toContain("svg");
    expect(cursorForTool("eraser")).toContain("circle");
  });

  it("leaves the select tool looking like nothing is armed", () => {
    // Select draws nothing, so it must not look like it is about to draw.
    expect(cursorForTool("select")).toBe("default");
  });

  it("puts the hotspot where the gesture starts, not at the icon's centre", () => {
    /*
     * A custom cursor's hotspot is the coordinate pair after the URL. If it sat at the
     * middle of the icon, every stroke would land a few pixels away from where the user
     * aimed — the usual way a prettier cursor makes drawing worse.
     */
    const pen = cursorForTool("freehand");
    // The nib points down-left, so the hotspot is near the bottom-left corner.
    expect(pen).toMatch(/\b2 18,/);
    const eraser = cursorForTool("eraser");
    // A ring is centred, so its hotspot is the centre.
    expect(eraser).toMatch(/\b11 11,/);
  });

  it("names a fallback cursor after the URL, for platforms that refuse data URIs", () => {
    /*
     * Without the trailing keyword the whole string is invalid and the browser falls back
     * to an arrow — losing the tool's symbol with no error anywhere. `region` is a plain
     * keyword, so only the custom cursors are checked here.
     */
    for (const tool of ["freehand", "arrow", "eraser"] as const) {
      expect(cursorForTool(tool)).toMatch(/,\s*[a-z-]+$/);
    }
  });
});

describe("cursorForShield", () => {
  it("is not a crosshair", () => {
    /*
     * The shield covers the entire window. A crosshair there claimed every margin and panel
     * gap was drawable, and it is what the user actually saw — the canvas covers only the
     * picture, so its cursor is rarely the one under the pointer.
     */
    expect(cursorForShield()).not.toBe("crosshair");
  });

  it("is the platform default, so only the picture looks drawable", () => {
    expect(cursorForShield()).toBe("default");
  });
});
