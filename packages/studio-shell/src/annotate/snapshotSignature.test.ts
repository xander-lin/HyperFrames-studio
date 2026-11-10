import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationShape } from "@mystudio/protocol";
import {
  liveStrokesOn,
  needsCapture,
  selectionKeyOf,
  snapshotSignature,
} from "./snapshotSignature.js";

/**
 * When a snapshot must be regenerated.
 *
 * The user's rule: the picture is the **current state**, taken when the state moved. Pressing
 * add-to-prompt twice with nothing drawn in between is one picture; drawing again, or
 * selecting a different element, makes a new one.
 */

const frame = {
  compositionPath: "index.html",
  time: 3,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function stroke(id: string, x: number, withdrawn = false): Annotation {
  const shape: AnnotationShape = {
    kind: "freehand",
    points: [
      { x, y: 0.2 },
      { x: x + 0.05, y: 0.3 },
    ],
    colour: "#ff3b30",
    width: 3,
  };
  return { id, shape, frame, note: "", createdAt: 1, ...(withdrawn ? { withdrawn } : {}) };
}

function ink(x: number): AnnotationShape {
  return {
    kind: "freehand",
    points: [
      { x, y: 0.2 },
      { x: x + 0.05, y: 0.3 },
    ],
    colour: "#ff3b30",
    width: 3,
  };
}

describe("snapshotSignature", () => {
  it("is identical for the same frame and the same strokes", () => {
    // The whole point: two presses with nothing changed must not regenerate the picture.
    const a = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [ink(0.1)] });
    const b = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [ink(0.1)] });
    expect(b).toBe(a);
  });

  it("changes when a stroke is added", () => {
    const a = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [ink(0.1)] });
    const b = snapshotSignature({
      compositionPath: "index.html",
      time: 3,
      strokes: [ink(0.1), ink(0.5)],
    });
    expect(b).not.toBe(a);
  });

  it("changes when a stroke is removed, so undo regenerates the picture", () => {
    // The stale-picture case: the old image still shows the stroke the user removed.
    const before = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [ink(0.1), ink(0.5)] });
    const after = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [ink(0.1)] });
    expect(after).not.toBe(before);
  });

  it("changes with the frame's timecode", () => {
    const here = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [] });
    const there = snapshotSignature({ compositionPath: "index.html", time: 3.5, strokes: [] });
    expect(there).not.toBe(here);
  });

  it("depends only on what the picture would show", () => {
    /*
     * The signature answers "is this a different picture from the last one I took", and a
     * capture is only ever taken for **handwriting**. An element brings its own frame image, so
     * selecting a different element cannot change whether a capture is needed — putting the
     * selection in here made the signature vary for something the image does not contain
     * (found.md F-122).
     *
     * Two frames that would render identically therefore share a signature, whatever is
     * selected in Studio.
     */
    const same = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [] });
    const again = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [] });
    expect(again).toBe(same);
  });

  it("changes when the strokes change, because the picture changes", () => {
    const blank = snapshotSignature({ compositionPath: "index.html", time: 3, strokes: [] });
    const drawn = snapshotSignature({
      compositionPath: "index.html",
      time: 3,
      strokes: [stroke("a", 0.1).shape],
    });
    expect(drawn).not.toBe(blank);
  });
});

describe("liveStrokesOn", () => {
  it("returns strokes on this frame only", () => {
    const annotations = [stroke("a", 0.1), { ...stroke("b", 0.4), frame: { ...frame, time: 9 } }];
    expect(liveStrokesOn(annotations, "index.html", 3)).toHaveLength(1);
  });

  it("skips withdrawn strokes, which are no longer on the frame", () => {
    const annotations = [stroke("a", 0.1), stroke("b", 0.4, true)];
    expect(liveStrokesOn(annotations, "index.html", 3)).toHaveLength(1);
  });

  it("skips regions and arrows: they are references, not ink", () => {
    const region: Annotation = {
      id: "r",
      shape: { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      frame,
      note: "",
      createdAt: 1,
    };
    expect(liveStrokesOn([region], "index.html", 3)).toEqual([]);
  });
});

describe("selectionKeyOf", () => {
  it("prefers the stable id, which survives reflow", () => {
    expect(selectionKeyOf({ hfId: "hf-1", id: "x", selector: ".a" })).toBe("hf:hf-1");
  });

  it("falls back to the DOM id, then to the selector with its index", () => {
    expect(selectionKeyOf({ id: "x" })).toBe("id:x");
    expect(selectionKeyOf({ selector: ".a", selectorIndex: 2 })).toBe("sel:.a#2");
  });

  it("is null when nothing is selected", () => {
    expect(selectionKeyOf(null)).toBeNull();
    expect(selectionKeyOf({})).toBeNull();
  });
});

describe("needsCapture", () => {
  /*
   * The reported defect: `Ctrl+S` on a **selected element** produced `Element 1` *and*
   * `Capture 2`, carrying the same picture twice. An element block already has its own frame
   * image, so the capture was a duplicate of evidence the reader was already given
   * (found.md F-122).
   */
  it("is true when the frame carries handwriting, which has no reference of its own", () => {
    expect(needsCapture([stroke("a", 0.1)], { compositionPath: "index.html", time: 3 })).toBe(true);
  });

  it("is false for a frame with no ink, so an element or region needs no second block", () => {
    expect(needsCapture([], { compositionPath: "index.html", time: 3 })).toBe(false);
  });

  it("is false when the only ink on the frame was undone", () => {
    // The picture would show nothing the user drew, so it is not a handwriting capture either.
    const withdrawn = { ...stroke("a", 0.1), withdrawn: true };
    expect(needsCapture([withdrawn], { compositionPath: "index.html", time: 3 })).toBe(false);
  });

  it("is false when the ink is on a different frame", () => {
    const other = { ...stroke("a", 0.1), frame: { ...frame, time: 9 } };
    expect(needsCapture([other], { compositionPath: "index.html", time: 3 })).toBe(false);
  });

  it("is true with ink even when regions and arrows are on the frame too", () => {
    // A scribble plus a circle: the ink still needs its picture, the region keeps its own block.
    const region = { ...stroke("b", 0.5), shape: { kind: "region" as const, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } } };
    expect(needsCapture([region, stroke("a", 0.1)], { compositionPath: "index.html", time: 3 })).toBe(true);
  });
});
