import { describe, expect, it } from "vitest";
import { submenuSide } from "./DockSubmenu.js";

/**
 * Which side a toolbar panel opens on.
 *
 * The rule is one sentence: **go where there is room.** The toolbar is draggable, so a
 * panel pinned to one side eventually ends up outside the window — that already happened
 * once (found.md F-065), and again when the panel stopped re-deciding while dragged
 * (found.md F-072).
 *
 * Testing the rule in isolation is what makes it trustworthy: the rendering can be checked
 * in a real window, but "does a toolbar at x open right" is arithmetic.
 */
describe("submenuSide", () => {
  it("opens to the right when the toolbar is in the left half", () => {
    // The panel must grow into the window, not off its edge.
    expect(submenuSide(100, 1000)).toBe("right");
    expect(submenuSide(499, 1000)).toBe("right");
  });

  it("opens to the left when the toolbar is in the right half", () => {
    expect(submenuSide(501, 1000)).toBe("left");
    expect(submenuSide(900, 1000)).toBe("left");
  });

  it("switches exactly at the middle, so a drag flips it once", () => {
    /*
     * A hysteresis gap would leave the panel on the wrong side for a while after the
     * crossover. A single threshold is predictable: cross it and the side changes.
     */
    expect(submenuSide(499.9, 1000)).toBe("right");
    expect(submenuSide(500, 1000)).toBe("left");
    expect(submenuSide(500.1, 1000)).toBe("left");
  });

  it("adapts to the window's width, not a fixed pixel value", () => {
    // The same toolbar position is "left half" in a wide window and "right half" in a
    // narrow one; a hard-coded midpoint would be wrong in one of them.
    expect(submenuSide(400, 1200)).toBe("right");
    expect(submenuSide(400, 700)).toBe("left");
  });

  it("never asks the panel to leave the window at either extreme", () => {
    // The toolbar can be dragged to either edge; the panel must open inward there.
    expect(submenuSide(0, 1000)).toBe("right");
    expect(submenuSide(1000, 1000)).toBe("left");
  });
});
