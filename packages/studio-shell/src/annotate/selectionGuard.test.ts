import { describe, expect, it } from "vitest";
import { isSelectableTarget, pointInStage } from "./selectionGuard.js";

/**
 * The guard's decisions.
 *
 * What is being protected: a press-and-drag over the video is a **drawing** gesture.
 * The browser's default reading is a **selection** gesture, which smears a highlight
 * across the page and can select the video element itself. Dragging where there is
 * nothing must be a no-op, not a selection.
 *
 * The predicates are pure, so the rules can be pinned down without a DOM.
 */

describe("pointInStage", () => {
  const stage = { left: 100, top: 50, width: 400, height: 200 };

  it("accepts a point inside the video", () => {
    expect(pointInStage({ x: 300, y: 150 }, stage)).toBe(true);
  });

  it("accepts the exact edges, so a drag from the border still counts", () => {
    expect(pointInStage({ x: 100, y: 50 }, stage)).toBe(true);
    expect(pointInStage({ x: 500, y: 250 }, stage)).toBe(true);
  });

  it("rejects a point outside the video, where a drag belongs to the page", () => {
    expect(pointInStage({ x: 99, y: 150 }, stage)).toBe(false);
    expect(pointInStage({ x: 501, y: 150 }, stage)).toBe(false);
  });

  it("is false while the stage has not been measured yet", () => {
    // Before layout settles we must not suppress selection: we would be guessing.
    expect(pointInStage({ x: 300, y: 150 }, null)).toBe(false);
  });
});

describe("isSelectableTarget", () => {
  it("exempts editable fields, where selecting text is the whole point", () => {
    expect(isSelectableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isSelectableTarget({ tagName: "input" })).toBe(true);
    expect(isSelectableTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("exempts contenteditable regions", () => {
    expect(isSelectableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(
      isSelectableTarget({
        tagName: "DIV",
        getAttribute: (name: string) => (name === "contenteditable" ? "true" : null),
      }),
    ).toBe(true);
  });

  it("exempts anything explicitly marked selectable", () => {
    // The prompt box is not an input element; it is marked so users can select text in it.
    expect(
      isSelectableTarget({
        tagName: "DIV",
        getAttribute: (name: string) => (name === "data-mystudio-selectable" ? "" : null),
      }),
    ).toBe(true);
  });

  it("exempts a descendant of a selectable region", () => {
    expect(
      isSelectableTarget({
        tagName: "SPAN",
        getAttribute: () => null,
        closest: (selector: string) => (selector === "[data-mystudio-selectable]" ? {} : null),
      }),
    ).toBe(true);
  });

  it("does not exempt ordinary nodes, which is what the guard is for", () => {
    expect(isSelectableTarget({ tagName: "VIDEO" })).toBe(false);
    expect(isSelectableTarget({ tagName: "DIV", getAttribute: () => null })).toBe(false);
    expect(isSelectableTarget(null)).toBe(false);
  });

  it("survives a node whose getAttribute or closest throws", () => {
    // Synthetic and cross-realm nodes may throw; a guard must not crash a drag.
    const hostile = {
      tagName: "DIV",
      getAttribute: () => {
        throw new Error("boom");
      },
      closest: () => {
        throw new Error("boom");
      },
    };
    expect(isSelectableTarget(hostile)).toBe(false);
  });
});
