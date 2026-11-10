import { describe, expect, it } from "vitest";
import { pageNumberOf, useBoardStore } from "./boardStore.js";
import type { AnnotationShape } from "@mystudio/protocol";

/**
 * The board's pages.
 *
 * Two requirements drove this file, both from the same user report:
 *
 * 1. **The page count is not derived from anything.** It used to be "one page per timeline
 *    scene", so a board could never have more pages than the video had cuts, and the user
 *    saw a deck of 11 that they never chose. A sketch pad decides its own length.
 * 2. **Turning a page is a board action.** It used to seek the video, because the page was
 *    the playhead. Sketching on paper and where the film is are unrelated things.
 *
 * The pager itself is ◀ n / N ▶, so what it needs from the store is: a current page, a
 * count, and bounded stepping.
 */

const stroke = (x = 0.5): AnnotationShape => ({
  kind: "freehand",
  points: [
    { x, y: 0.5, pressure: null },
    { x: x + 0.05, y: 0.55, pressure: null },
  ],
  colour: "#101114",
  width: 3,
} as AnnotationShape);

/** A fresh board for each test: the store is a module singleton. */
function freshBoard() {
  useBoardStore.setState({
    mode: "video",
    pages: [{ key: "page_1", marks: [] }],
    current: "page_1",
    history: {},
  });
  return useBoardStore;
}

describe("a board starts as one page", () => {
  it("has a page to draw on before anything is created", () => {
    /*
     * Starting at zero would force "which page am I on" to answer "none", and every
     * operation would need a special case for it.
     */
    const store = freshBoard();
    expect(store.getState().pages).toHaveLength(1);
    expect(store.getState().current).toBe("page_1");
  });

  it("numbers that page one", () => {
    freshBoard();
    expect(pageNumberOf(useBoardStore.getState().pages, "page_1")).toBe(1);
  });
});

describe("the page count belongs to the board", () => {
  it("grows when a page is added, and only then", () => {
    /*
     * The regression: the count used to equal the number of timeline scenes, so it was
     * not the board's at all. Nothing outside this store may change it.
     */
    const store = freshBoard();
    expect(store.getState().pages).toHaveLength(1);
    store.getState().addPage();
    expect(store.getState().pages).toHaveLength(2);
    store.getState().addPage();
    expect(store.getState().pages).toHaveLength(3);
  });

  it("has no upper limit", () => {
    // A page limit that nobody chose is exactly what the user objected to.
    const store = freshBoard();
    for (let index = 0; index < 60; index += 1) store.getState().addPage();
    expect(store.getState().pages).toHaveLength(61);
  });

  it("inserts the new page after the current one, not at the end", () => {
    // "New page" continues the deck where the user is; appending somewhere off-screen is
    // not the same action.
    const store = freshBoard();
    const second = store.getState().addPage();
    store.getState().setCurrent("page_1");
    store.getState().addPage();
    const keys = store.getState().pages.map((page) => page.key);
    expect(keys[1]).not.toBe(second);
    expect(keys[0]).toBe("page_1");
    expect(keys).toHaveLength(3);
  });

  it("keeps at least one page when the current one is removed", () => {
    // An empty deck has no surface to draw on.
    const store = freshBoard();
    expect(store.getState().removeCurrentPage()).toBe(false);
    expect(store.getState().pages).toHaveLength(1);
  });

  it("removes the current page when there is more than one", () => {
    const store = freshBoard();
    const second = store.getState().addPage();
    expect(store.getState().current).toBe(second);
    expect(store.getState().removeCurrentPage()).toBe(true);
    expect(store.getState().pages).toHaveLength(1);
    // A valid page is showing afterwards, not a dangling key.
    const { pages, current } = store.getState();
    expect(pages.some((page) => page.key === current)).toBe(true);
  });
});

describe("stepping through the deck", () => {
  it("moves one page at a time", () => {
    const store = freshBoard();
    const second = store.getState().addPage();
    store.getState().setCurrent("page_1");
    expect(store.getState().stepPage(1)).toBe(true);
    expect(store.getState().current).toBe(second);
  });

  it("stops at the ends instead of wrapping", () => {
    /*
     * Wrapping would make "previous" on page 1 jump to the last page — a move nobody asked
     * for, on a control whose whole job is "the adjacent page". The pager's arrows are
     * disabled there; this is the same rule underneath.
     */
    const store = freshBoard();
    expect(store.getState().stepPage(-1)).toBe(false);
    expect(store.getState().stepPage(1)).toBe(false);
    expect(store.getState().current).toBe("page_1");
  });

  it("reports whether it moved, so the key can fall through when it cannot", () => {
    // Commands return whether they acted; a page turn that cannot happen must not consume
    // the keypress.
    const store = freshBoard();
    store.getState().addPage();
    expect(store.getState().stepPage(1)).toBe(false);
    expect(store.getState().stepPage(-1)).toBe(true);
  });

  it("ignores an unknown page instead of losing the pointer", () => {
    const store = freshBoard();
    store.getState().setCurrent("nope");
    expect(store.getState().current).toBe("page_1");
  });
});

describe("ink stays with its page", () => {
  it("files a stroke on the page that was current", () => {
    const store = freshBoard();
    const second = store.getState().addPage();
    store.getState().addStroke(second, stroke());
    expect(store.getState().strokesOf(second)).toHaveLength(1);
    expect(store.getState().strokesOf("page_1")).toHaveLength(0);
  });

  it("does not move a sketch when a page is inserted before it", () => {
    /*
     * Page identity is an opaque key, not a position. Inserting a sheet must not shift
     * existing sketches onto their neighbour's page.
     */
    const store = freshBoard();
    store.getState().addStroke("page_1", stroke());
    store.getState().setCurrent("page_1");
    store.getState().addPage();
    expect(store.getState().strokesOf("page_1")).toHaveLength(1);
    expect(pageNumberOf(store.getState().pages, "page_1")).toBe(1);
  });

  it("keeps each page's undo history separate", () => {
    const store = freshBoard();
    const second = store.getState().addPage();
    store.getState().addStroke("page_1", stroke());
    store.getState().addStroke(second, stroke(0.2));
    store.getState().undoPage(second);
    expect(store.getState().strokesOf("page_1")).toHaveLength(1);
    expect(store.getState().strokesOf(second)).toHaveLength(0);
  });

  it("clears one page and leaves the others untouched", () => {
    const store = freshBoard();
    const second = store.getState().addPage();
    store.getState().addStroke("page_1", stroke());
    store.getState().addStroke(second, stroke(0.2));
    store.getState().clearPage("page_1");
    expect(store.getState().strokesOf("page_1")).toHaveLength(0);
    expect(store.getState().strokesOf(second)).toHaveLength(1);
  });
});

describe("turning a page never touches the video", () => {
  it("is a store operation with no player involvement", () => {
    /*
     * The old design derived the page from `currentTime` and made a page turn call
     * `requestSeek`, so flipping a sheet moved the film. The board store no longer has any
     * access to the player: it cannot, by construction, seek anything.
     */
    const store = freshBoard();
    store.getState().addPage();
    store.getState().setCurrent("page_1");
    expect(store.getState().stepPage(1)).toBe(true);
    // Only board state changed; there is no time field left to have changed.
    expect(Object.keys(store.getState())).not.toContain("time");
  });
});
