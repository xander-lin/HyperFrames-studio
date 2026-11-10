import { beforeEach, describe, expect, it } from "vitest";
import { selectPageHasInk, useBoardStore } from "./boardStore.js";
import type { AnnotationShape } from "@mystudio/protocol";

/**
 * The board as a store: switching surfaces, drawing, erasing, undoing.
 *
 * Page navigation has its own file (`boardPages.test.ts`). This one covers the ink and the
 * isolation guarantees, which are the reason the board is a **separate store** rather than
 * a filtered part of the annotation store.
 */

const stroke = (x = 0.5): AnnotationShape =>
  ({
    kind: "freehand",
    points: [
      { x, y: 0.5, pressure: null },
      { x: x + 0.05, y: 0.55, pressure: null },
    ],
    colour: "#101114",
    width: 3,
  }) as AnnotationShape;

beforeEach(() => {
  useBoardStore.setState({
    mode: "video",
    pen: { colour: "#101114", width: 3 },
    pages: [{ key: "page_1", marks: [] }],
    current: "page_1",
    history: {},
  });
});

describe("switching surfaces", () => {
  it("starts on the video", () => {
    expect(useBoardStore.getState().mode).toBe("video");
  });

  it("toggles without touching any ink", () => {
    useBoardStore.getState().addStroke("page_1", stroke());
    useBoardStore.getState().toggleMode();
    expect(useBoardStore.getState().mode).toBe("board");
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
    useBoardStore.getState().toggleMode();
    expect(useBoardStore.getState().mode).toBe("video");
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
  });
});

describe("drawing and erasing on a page", () => {
  it("adds a stroke to the page it was given", () => {
    const id = useBoardStore.getState().addStroke("page_1", stroke());
    expect(typeof id).toBe("string");
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
  });

  it("keeps pages independent", () => {
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_2", stroke(0.2));
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
    expect(useBoardStore.getState().strokesOf("page_2")).toHaveLength(1);
  });

  it("erases one stroke and leaves the rest", () => {
    const first = useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_1", stroke(0.2));
    useBoardStore.getState().eraseStroke("page_1", first);
    const marks = useBoardStore.getState().strokesOf("page_1");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).not.toBe(first);
  });

  it("reports a miss instead of pretending to erase", () => {
    // The eraser is a hit test; "nothing there" must be distinguishable from "removed".
    expect(useBoardStore.getState().eraseStroke("page_1", "missing")).toBe(false);
  });

  it("clears only the page it was given", () => {
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_2", stroke(0.2));
    expect(useBoardStore.getState().clearPage("page_1")).toBe(1);
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(0);
    expect(useBoardStore.getState().strokesOf("page_2")).toHaveLength(1);
  });

  it("says how much it cleared, and zero when the page was already empty", () => {
    useBoardStore.getState().addStroke("page_1", stroke());
    useBoardStore.getState().addStroke("page_1", stroke(0.2));
    expect(useBoardStore.getState().clearPage("page_1")).toBe(2);
    expect(useBoardStore.getState().clearPage("page_1")).toBe(0);
  });
});

describe("undo on the board", () => {
  it("removes the newest stroke, one at a time", () => {
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_1", stroke(0.2));
    expect(useBoardStore.getState().undoPage("page_1")).toBe(true);
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
  });

  it("reports false when there is nothing to undo", () => {
    // Undo must not be consumed when it cannot act, or the key is dead on the board.
    expect(useBoardStore.getState().undoPage("page_1")).toBe(false);
  });

  it("does not undo across pages", () => {
    // Each page has its own history; undoing on page 2 must not pull ink off page 1.
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_2", stroke(0.5));
    useBoardStore.getState().undoPage("page_2");
    expect(useBoardStore.getState().strokesOf("page_1")).toHaveLength(1);
  });
});

describe("selectPageHasInk", () => {
  it("is false for an untouched page", () => {
    expect(selectPageHasInk("page_1")(useBoardStore.getState())).toBe(false);
  });

  it("is true once a stroke lands", () => {
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    expect(selectPageHasInk("page_1")(useBoardStore.getState())).toBe(true);
  });
});

describe("the board cannot reach the video's annotations", () => {
  it("accepts every tool, not only ink", () => {
    /*
     * A page used to accept freehand only, on the reasoning that a box or an arrow "would
     * have to become a numbered block". It would not: a page has no prompt, so nothing
     * refers to the shape. Refusing it took away the two most useful sketch gestures for a
     * consequence that never happens.
     */
    useBoardStore.getState().addStroke("page_1", stroke(0.1));
    useBoardStore.getState().addStroke("page_1", {
      kind: "region",
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    } as AnnotationShape);
    useBoardStore.getState().addStroke("page_1", {
      kind: "arrow",
      from: { x: 0.2, y: 0.8 },
      to: { x: 0.6, y: 0.3 },
    } as AnnotationShape);
    const kinds = useBoardStore.getState().strokesOf("page_1").map((m) => m.stroke.kind);
    expect(kinds).toEqual(["freehand", "region", "arrow"]);
  });

  it("numbers nothing, and delivers nothing", () => {
    /*
     * The structural guarantee this file exists for, restated for the broader type: the
     * board store has no ordinal and no bundle. Referencing is a property of the
     * **annotation** store, so nothing drawn here can end up in a prompt — which is what
     * keeps "clearing the board leaves the video alone" true.
     */
    useBoardStore.getState().addStroke("page_1", {
      kind: "region",
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    } as AnnotationShape);
    const mark = useBoardStore.getState().strokesOf("page_1")[0];
    expect(mark).toBeDefined();
    // No ordinal anywhere in the stored record.
    expect(JSON.stringify(mark)).not.toMatch(/ordinal|number|index/i);
  });
});
