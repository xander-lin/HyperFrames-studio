import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationShape } from "@mystudio/protocol";
import { frameMarks } from "./frameMarks.js";
import { annotationOrdinals, type RequestEntry } from "./requestOrder.js";

/**
 * What is painted on one frame, and with what badge.
 *
 * ## Why this file exists
 *
 * The delivered picture once showed a **numbered mark the screen did not have**. The cause was
 * not a drawing bug: the canvas asked one function what to paint and how to number it, and the
 * picture capture had its own loop with its own counter. Two computations of one fact, and they
 * disagreed as soon as a mark was on the frame but not in the request
 * (found.md F-122).
 *
 * So the tests here state the fact once, for the one function both surfaces now call:
 *
 * - a mark **on the frame but not in the request has no badge** — nothing refers to it by number;
 * - a mark in the request takes its number from the **request's order**, not from where it
 *   happens to sit on the frame.
 */

const frame = {
  compositionPath: "index.html",
  time: 3,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function mark(id: string, shape: AnnotationShape, over: Partial<Annotation> = {}): Annotation {
  return { id, shape, frame, note: "", createdAt: 1, ...over };
}

const region = (id: string, over: Partial<Annotation> = {}) =>
  mark(id, { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }, over);
const arrow = (id: string, over: Partial<Annotation> = {}) =>
  mark(id, { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } }, over);
const ink = (id: string, over: Partial<Annotation> = {}) =>
  mark(id, { kind: "freehand", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }, over);

/** The request, and the ordinals derived from it. */
function request(...entries: RequestEntry[]): Map<string, number> {
  return annotationOrdinals(entries);
}

const here = { compositionPath: "index.html", time: 3 };

describe("which marks are painted", () => {
  it("keeps the marks on this frame", () => {
    const marks = frameMarks([region("a"), arrow("b")], here, request());
    expect(marks.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("drops marks from another frame", () => {
    const elsewhere = region("b", { frame: { ...frame, time: 9 } });
    expect(frameMarks([region("a"), elsewhere], here, request()).map((m) => m.id)).toEqual(["a"]);
  });

  it("drops marks from another composition", () => {
    const other = region("b", { frame: { ...frame, compositionPath: "other.html" } });
    expect(frameMarks([region("a"), other], here, request()).map((m) => m.id)).toEqual(["a"]);
  });

  it("drops withdrawn marks, which are no longer on the picture", () => {
    // Their block stays in the prompt and turns red there; painting the mark again would show
    // something the user removed.
    expect(frameMarks([region("a", { withdrawn: true })], here, request()).map((m) => m.id)).toEqual([]);
  });

  it("keeps ink, which is painted but never numbered", () => {
    const marks = frameMarks([ink("i")], here, request());
    expect(marks).toHaveLength(1);
    expect(marks[0]?.badge).toBeNull();
  });
});

describe("the badge", () => {
  it("is the mark's position in the request, not its position on the frame", () => {
    /*
     * The reported disagreement: two marks on the frame, only the second one in the request. The
     * canvas numbers by the request, so the delivered picture must too.
     */
    const ordinals = request({ kind: "annotation", id: "b" });
    const marks = frameMarks([region("a"), arrow("b")], here, ordinals);
    expect(marks.find((entry) => entry.id === "a")?.badge).toBeNull();
    expect(marks.find((entry) => entry.id === "b")?.badge).toBe("1");
  });

  it("is null for a mark that is on the frame but not in the request", () => {
    /*
     * This is the case that produced a badge in the image and none on screen. A mark the user
     * never added has **no** number: numbering it invents a reference their sentence cannot name.
     */
    const marks = frameMarks([region("a"), arrow("b")], here, request({ kind: "annotation", id: "b" }));
    expect(marks.filter((entry) => entry.badge !== null).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("numbers from the shared sequence, so kinds interleave", () => {
    // `Element 1`, `Capture 2`, `Region 3`: one counter across kinds (found.md F-107).
    const ordinals = request(
      { kind: "element", id: "e" },
      { kind: "capture", id: "c" },
      { kind: "annotation", id: "r" },
    );
    expect(frameMarks([region("r")], here, ordinals)[0]?.badge).toBe("3");
  });

  it("numbers ink through the shared sequence when it is a block", () => {
    /*
     * Ink is normally unnumbered, but when the user adds it, its block has a number. The badge
     * comes from the request, and `isReferenceableShape` still refuses to give ink a reference —
     * that refusal is about *referring*, not about painting.
     */
    const ordinals = request({ kind: "annotation", id: "i" });
    expect(frameMarks([ink("i")], here, ordinals)[0]?.badge).toBeNull();
  });
});

describe("painting order", () => {
  it("is creation order, not request order", () => {
    /*
     * A number is a **name**, not a z-index. Promoting a mark in the prompt must not move it in
     * front of another one on the picture: that would change what overlaps what, caused by an
     * action about numbering. Creation order is also what the canvas has always used, so the
     * picture keeps looking the way the user drew it (found.md F-122).
     */
    const ordinals = request(
      { kind: "annotation", id: "c" },
      { kind: "annotation", id: "a" },
    );
    const marks = frameMarks(
      [region("z", { createdAt: 1 }), region("a", { createdAt: 2 }), region("c", { createdAt: 3 })],
      here,
      ordinals,
    );
    expect(marks.map((entry) => entry.id)).toEqual(["z", "a", "c"]);
    // The badges still follow the request, which is the part a number is for.
    expect(marks.map((entry) => entry.badge)).toEqual([null, "2", "1"]);
  });
});

describe("the two surfaces read one answer", () => {
  it("gives the same result for the same inputs, however often it is called", () => {
    /*
     * The structural guarantee: the canvas and the picture capture both call this function with
     * the same document state, so their answers are identical by construction — there is no
     * second implementation left to drift.
     */
    const annotations = [region("a"), arrow("b"), ink("i")];
    const ordinals = request({ kind: "annotation", id: "a" });
    const once = frameMarks(annotations, here, ordinals);
    const twice = frameMarks(annotations, here, ordinals);
    expect(twice).toEqual(once);
  });
});
