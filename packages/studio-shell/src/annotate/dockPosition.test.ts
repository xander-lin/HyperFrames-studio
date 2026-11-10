import { describe, expect, it } from "vitest";
import {
  DOCK_WIDTH,
  DRAG_THRESHOLD,
  clampDockPosition,
  isBeyondDragThreshold,
  positionAfterDrag,
} from "./dockPosition.js";

const viewport = { width: 1100, height: 800 };

describe("isBeyondDragThreshold", () => {
  it("treats a click as a click, not a drag", () => {
    // Clicking a tool icon wobbles the pointer 1~2px; that must not count as a drag.
    expect(isBeyondDragThreshold(0, 0)).toBe(false);
    expect(isBeyondDragThreshold(1, 1)).toBe(false);
    expect(isBeyondDragThreshold(2, 2)).toBe(false);
  });

  it("accepts movement at or beyond the threshold", () => {
    expect(isBeyondDragThreshold(DRAG_THRESHOLD, 0)).toBe(true);
    // Diagonal movement uses Euclidean distance: (3,3) is 4.24, already past 4.
    expect(isBeyondDragThreshold(3, 3)).toBe(true);
  });

  it("works in the negative direction too", () => {
    expect(isBeyondDragThreshold(-10, 0)).toBe(true);
    expect(isBeyondDragThreshold(0, -10)).toBe(true);
  });
});

describe("clampDockPosition", () => {
  it("lets the dock sit anywhere inside the viewport", () => {
    expect(clampDockPosition({ left: 300, top: 200 }, 240, viewport)).toEqual({ left: 300, top: 200 });
  });

  it("measures the toolbar at its expanded width, not just the collapsed one", () => {
    /*
     * The toolbar grows leftwards while the board is showing, because the page list sits
     * beside the board button. Clamping with the collapsed width let the expanded row hang
     * past the window edge, where its buttons were clipped and unclickable: the control
     * rendered and could not be used.
     */
    const expanded = 86;
    const clamped = clampDockPosition({ left: 5000, top: 0 }, 240, viewport, expanded);
    expect(clamped.left).toBe(viewport.width - expanded - 4);
    // And it is a stricter constraint than the collapsed width.
    expect(clamped.left).toBeLessThan(viewport.width - DOCK_WIDTH - 4);
  });

  it("never asks for a negative width when the toolbar is narrower than the default", () => {
    const clamped = clampDockPosition({ left: 5000, top: 0 }, 240, viewport, 10);
    expect(clamped.left).toBe(viewport.width - DOCK_WIDTH - 4);
  });

  it("keeps the whole dock on screen instead of letting half of it escape", () => {
    // Dragged to the far right: the whole toolbar (including width) must stay inside the
    // viewport, or the user can never click it again.
    const clamped = clampDockPosition({ left: 5000, top: 0 }, 240, viewport);
    expect(clamped.left).toBe(viewport.width - DOCK_WIDTH - 4);
  });

  it("keeps a minimum margin so the dock never sticks to the very edge", () => {
    expect(clampDockPosition({ left: -500, top: -500 }, 240, viewport)).toEqual({ left: 4, top: 4 });
  });

  it("accounts for the dock's own height at the bottom edge", () => {
    const clamped = clampDockPosition({ left: 100, top: 5000 }, 240, viewport);
    expect(clamped.top).toBe(viewport.height - 240 - 4);
  });

  it("falls back to the top-left corner when the viewport is smaller than the dock", () => {
    // In an extremely narrow viewport maxLeft goes negative; the position must not
    // become negative (it would be clipped away).
    const tiny = { width: 30, height: 20 };
    expect(clampDockPosition({ left: 999, top: 999 }, 240, tiny)).toEqual({ left: 4, top: 4 });
  });

  it("rescues a stored position that belongs to a wider window", () => {
    /*
     * Observed bug: the toolbar was dragged at `left: 1272` in a wide window, the
     * position was persisted, and the app was next opened 1100px wide. The toolbar
     * rendered entirely past the right edge — present in the DOM, invisible on screen,
     * and unreachable because there was nothing to click.
     *
     * The stored value must therefore be clamped when read, never trusted.
     */
    const wide = { left: 1272, top: 178 };
    const clamped = clampDockPosition(wide, 240, viewport);
    expect(clamped.left).toBe(viewport.width - DOCK_WIDTH - 4);
    // Vertically it still fits, so it is left alone.
    expect(clamped.top).toBe(178);
  });

  it("is idempotent, so clamping a clamped position changes nothing", () => {
    // The dock clamps on read, on mount and on resize; those must not fight.
    const once = clampDockPosition({ left: 1272, top: 178 }, 240, viewport);
    expect(clampDockPosition(once, 240, viewport)).toEqual(once);
  });
});

describe("positionAfterDrag", () => {
  it("moves by exactly the pointer delta", () => {
    // Dragging must track 1:1; any acceleration or snapping makes it feel ungrabbable.
    expect(positionAfterDrag({ left: 100, top: 100 }, 40, -25)).toEqual({ left: 140, top: 75 });
  });

  it("does not mutate the origin", () => {
    const origin = { left: 100, top: 100 };
    positionAfterDrag(origin, 10, 10);
    expect(origin).toEqual({ left: 100, top: 100 });
  });
});
