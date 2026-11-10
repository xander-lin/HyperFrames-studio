import { beforeEach, describe, expect, it } from "vitest";
import { selectCanRedo, selectCanUndo, useAnnotationStore } from "./annotationStore.js";
import type { AnnotationShape } from "@mystudio/protocol";

/**
 * Store behaviour that other code relies on.
 *
 * The store is a zustand singleton, so every case resets it first.
 */

const frame = {
  compositionPath: "index.html",
  time: 1.5,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function region(x = 0.1, y = 0.1): AnnotationShape {
  return { kind: "region", rect: { x, y, width: 0.2, height: 0.2 } };
}

/** Record one mark and return its id. */
function mark(shape: AnnotationShape = region()): string {
  return useAnnotationStore.getState().add({ shape, frame }).id;
}

beforeEach(() => {
  useAnnotationStore.setState({ annotations: [], boundIds: [], past: [], future: [] });
});

describe("add", () => {
  it("records a mark immediately, with no note and no binding", () => {
    const id = mark();
    const state = useAnnotationStore.getState();
    expect(state.annotations).toHaveLength(1);
    // Drawing is not a request to send: only pressing S binds.
    expect(state.boundIds).toEqual([]);
    expect(state.annotations[0]?.id).toBe(id);
    expect(state.annotations[0]?.note).toBe("");
  });

  it("keeps marks in creation order, which is also the badge order", () => {
    const first = mark();
    const second = mark();
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([first, second]);
  });
});

describe("setFrameImagePath", () => {
  it("attaches the capture after the annotation already exists", () => {
    // The capture is taken asynchronously after the stroke, so the path arrives late.
    const id = mark();
    expect(useAnnotationStore.getState().annotations[0]?.frameImagePath).toBeUndefined();

    useAnnotationStore.getState().setFrameImagePath(id, "/tmp/frames/ann.png");

    const stored = useAnnotationStore.getState().annotations.find((a) => a.id === id);
    expect(stored?.frameImagePath).toBe("/tmp/frames/ann.png");
  });

  it("ignores an unknown id instead of throwing", () => {
    expect(() => useAnnotationStore.getState().setFrameImagePath("nope", "/tmp/x.png")).not.toThrow();
  });
});

describe("bind / unbind", () => {
  it("binds once even when called repeatedly", () => {
    const id = mark();
    const { bind } = useAnnotationStore.getState();
    bind(id);
    bind(id);
    expect(useAnnotationStore.getState().boundIds).toEqual([id]);
  });

  it("unbinds an id that is not bound without disturbing the rest", () => {
    const id = mark();
    useAnnotationStore.getState().bind(id);
    useAnnotationStore.getState().unbind("not-there");
    expect(useAnnotationStore.getState().boundIds).toEqual([id]);
  });
});

describe("undo / redo", () => {
  it("removes an unbound mark and can put it back", () => {
    const id = mark();
    expect(useAnnotationStore.getState().undo()).toBe("removed");
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);

    expect(useAnnotationStore.getState().redo()).toBe("removed");
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([id]);
  });

  it("withdraws a bound mark instead of deleting it, and undo/redo flips the flag", () => {
    /*
     * The user's prompt text says "Arrow 1". Deleting the mark would renumber every
     * later block and silently repoint their sentence, so the block stays and turns
     * red instead.
     */
    const id = mark();
    useAnnotationStore.getState().bind(id);

    expect(useAnnotationStore.getState().undo()).toBe("withdrawn");
    expect(useAnnotationStore.getState().annotations[0]?.withdrawn).toBe(true);
    // Still bound: the block is in the prompt, it is just stale.
    expect(useAnnotationStore.getState().boundIds).toEqual([id]);

    expect(useAnnotationStore.getState().redo()).toBe("withdrawn");
    expect(useAnnotationStore.getState().annotations[0]?.withdrawn).toBeFalsy();
  });

  it("undoes one action at a time, newest first", () => {
    const first = mark(region(0.0, 0.0));
    const second = mark(region(0.5, 0.5));

    // The second `mark` is the newest action, so it goes first.
    expect(useAnnotationStore.getState().undo()).toBe("removed");
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([first]);

    expect(useAnnotationStore.getState().undo()).toBe("removed");
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);

    expect(useAnnotationStore.getState().undo()).toBe("none");
  });

  it("redo replays in the order the actions were undone", () => {
    const first = mark(region(0.0, 0.0));
    const second = mark(region(0.5, 0.5));
    useAnnotationStore.getState().undo();
    useAnnotationStore.getState().undo();

    useAnnotationStore.getState().redo();
    useAnnotationStore.getState().redo();

    // Restored in creation order, because block ordinals are positional.
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([first, second]);
  });

  it("reports none with nothing to undo or redo", () => {
    expect(useAnnotationStore.getState().undo()).toBe("none");
    expect(useAnnotationStore.getState().redo()).toBe("none");
  });

  it("discards the redo branch once a new mark is drawn", () => {
    /*
     * Redo after new work would resurrect a mark on top of something the user drew
     * after undoing — a state they never asked for and cannot reason about.
     */
    mark();
    useAnnotationStore.getState().undo();
    mark(region(0.7, 0.7));
    expect(useAnnotationStore.getState().redo()).toBe("none");
  });

  it("makes erasing undoable", () => {
    const id = mark(region(0.2, 0.2));
    useAnnotationStore.getState().eraseAt({ x: 0.3, y: 0.3 }, 0.01);
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);

    expect(useAnnotationStore.getState().undo()).toBe("removed");
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([id]);
  });

  it("makes clearing all undoable in one step", () => {
    const first = mark(region(0.1, 0.1));
    const second = mark(region(0.5, 0.5));
    useAnnotationStore.getState().clear();
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);

    // One undo restores everything: clearing is one action, not two.
    useAnnotationStore.getState().undo();
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual([first, second]);
  });

  it("exposes whether anything is undoable without storing a copy of the stack length", () => {
    expect(selectCanUndo(useAnnotationStore.getState())).toBe(false);
    expect(selectCanRedo(useAnnotationStore.getState())).toBe(false);

    mark();
    expect(selectCanUndo(useAnnotationStore.getState())).toBe(true);

    useAnnotationStore.getState().undo();
    expect(selectCanUndo(useAnnotationStore.getState())).toBe(false);
    expect(selectCanRedo(useAnnotationStore.getState())).toBe(true);
  });
});

describe("eraseAt", () => {
  it("hits a region the point is inside", () => {
    const id = mark(region(0.2, 0.2));
    const hit = useAnnotationStore.getState().eraseAt({ x: 0.3, y: 0.3 }, 0.01);
    expect(hit).toEqual([id]);
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
  });

  it("misses a region the point is outside", () => {
    mark(region(0.2, 0.2));
    expect(useAnnotationStore.getState().eraseAt({ x: 0.9, y: 0.9 }, 0.01)).toEqual([]);
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
  });

  it("hits an arrow only near its shaft, not beyond its head", () => {
    useAnnotationStore.getState().add({
      shape: { kind: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.4, y: 0.2 } },
      frame,
    });
    const { eraseAt } = useAnnotationStore.getState();

    // On the shaft.
    expect(eraseAt({ x: 0.3, y: 0.2 }, 0.02)).toHaveLength(1);
    // Past the head, in empty space: the eraser must not reach there.
    useAnnotationStore.getState().add({
      shape: { kind: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.4, y: 0.2 } },
      frame,
    });
    expect(eraseAt({ x: 0.8, y: 0.2 }, 0.02)).toEqual([]);
  });

  it("withdraws a bound mark rather than deleting it", () => {
    const id = mark();
    useAnnotationStore.getState().bind(id);
    useAnnotationStore.getState().eraseAt({ x: 0.2, y: 0.2 }, 0.01);
    expect(useAnnotationStore.getState().annotations[0]?.withdrawn).toBe(true);
    expect(useAnnotationStore.getState().boundIds).toEqual([id]);
  });

  it("does not touch marks that are already withdrawn", () => {
    const id = mark();
    useAnnotationStore.getState().bind(id);
    useAnnotationStore.getState().undo();
    expect(useAnnotationStore.getState().eraseAt({ x: 0.2, y: 0.2 }, 0.01)).toEqual([]);
  });
});

describe("clear", () => {
  it("withdraws bound marks and deletes the rest", () => {
    const bound = mark(region(0.0, 0.0));
    mark(region(0.5, 0.5));
    useAnnotationStore.getState().bind(bound);

    expect(useAnnotationStore.getState().clear()).toBe(2);

    const left = useAnnotationStore.getState().annotations;
    // The unbound one is gone; the bound one survives, marked withdrawn.
    expect(left.map((a) => a.id)).toEqual([bound]);
    expect(left[0]?.withdrawn).toBe(true);
    expect(useAnnotationStore.getState().boundIds).toEqual([bound]);
  });

  it("reports zero when there is nothing to clear", () => {
    expect(useAnnotationStore.getState().clear()).toBe(0);
  });
});

describe("remove", () => {
  it("removes the annotation and its binding together", () => {
    const id = mark();
    useAnnotationStore.getState().bind(id);
    useAnnotationStore.getState().remove(id);
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    expect(useAnnotationStore.getState().boundIds).toEqual([]);
  });

  it("leaves the redo branch alone when the id is already gone", () => {
    /*
     * Removing something that is not there is a no-op. Treating it as an action used to
     * clear `future`, so a missing id silently destroyed the user's redo history.
     */
    mark();
    mark();
    useAnnotationStore.getState().undo();
    expect(useAnnotationStore.getState().future.length).toBe(1);

    useAnnotationStore.getState().remove("ann_does_not_exist");

    expect(useAnnotationStore.getState().future.length).toBe(1);
  });
});
