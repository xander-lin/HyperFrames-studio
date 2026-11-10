import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationShape, ElementTarget } from "@mystudio/protocol";
import { decideNextAction } from "./nextAction.js";

/**
 * What `Ctrl+S` adds: **one** block, decided from the last action.
 *
 * ## The defect this replaces
 *
 * The decision used to live in three places — the shortcut handler, `addToPrompt`, and
 * `addElementToPrompt` — and one press could reach two of them. Selecting an element and pressing
 * the key therefore produced `Element 1` **and** `Capture 2`, carrying the same picture twice
 * (found.md F-122).
 *
 * So these tests state the rule the product states: the kind is a function of the last action,
 * and there is exactly one answer.
 */

const frame = {
  compositionPath: "index.html",
  time: 3,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function mark(id: string, shape: AnnotationShape): Annotation {
  return { id, shape, frame, note: "", createdAt: Number(id.replace(/\D/g, "")) || 1 };
}

const region = (id: string) => mark(id, { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
const arrow = (id: string) =>
  mark(id, { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } });
const ink = (id: string) =>
  mark(id, { kind: "freehand", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });

const title: ElementTarget = { tagName: "h1", selector: ".title", hfId: "hf-1" };

/** Decide with the defaults a real press would have. */
function decide(over: Partial<Parameters<typeof decideNextAction>[0]> = {}) {
  return decideNextAction({
    selected: null,
    selectedAlreadyAdded: false,
    annotations: [],
    bound: [],
    ...over,
  });
}

describe("an element selection", () => {
  it("is an Element block, and nothing else", () => {
    /*
     * The reported defect, as one assertion: a selected element must not also produce a capture.
     * `decideNextAction` returns a single kind, so a second block cannot be produced from here.
     */
    const action = decide({ selected: title });
    expect(action).toEqual({ kind: "element", target: title });
  });

  it("wins over a mark drawn earlier", () => {
    // The element was pointed at just now; the drawing is older.
    const action = decide({ selected: title, annotations: [region("a1")] });
    expect(action.kind).toBe("element");
  });

  it("wins over ink drawn earlier, for the same reason", () => {
    const action = decide({ selected: title, annotations: [ink("a1")] });
    expect(action.kind).toBe("element");
  });

  it("falls through when it is already a block", () => {
    /*
     * Pressing again on the same element must not duplicate it. Once it is in the request, the
     * answer moves on to whatever else the user might mean.
     */
    const action = decide({
      selected: title,
      selectedAlreadyAdded: true,
      annotations: [region("a1")],
    });
    expect(action.kind).toBe("mark");
  });
});

describe("a drawn mark", () => {
  it("is a Region or an Arrow block, carrying its own picture", () => {
    expect(decide({ annotations: [region("a1")] })).toEqual({
      kind: "mark",
      annotation: region("a1"),
    });
    expect(decide({ annotations: [arrow("a2")] }).kind).toBe("mark");
  });

  it("does not produce a capture beside it", () => {
    // Same rule as the element: one press, one block.
    expect(decide({ annotations: [region("a1")] }).kind).not.toBe("capture");
  });

  it("picks the newest unadded one, so a second press adds the next", () => {
    const action = decide({
      annotations: [region("a1"), arrow("a2")],
      bound: ["a2"],
    });
    expect(action.kind).toBe("mark");
    if (action.kind === "mark") expect(action.annotation.id).toBe("a1");
  });
});

describe("handwriting", () => {
  it("is a Capture block, because ink has no reference to name", () => {
    expect(decide({ annotations: [ink("a1")] }).kind).toBe("capture");
  });

  it("wins over an older, unadded mark: the user just drew it", () => {
    /*
     * A scribble made after a circle is what the user means. Adding the older circle instead
     * would silently ignore the stroke they just drew.
     */
    expect(decide({ annotations: [region("a1"), ink("a2")] }).kind).toBe("capture");
  });

  it("loses to a mark drawn after it", () => {
    // The circle is newer, so the circle is what `Ctrl+S` names.
    expect(decide({ annotations: [ink("a1"), region("a2")] }).kind).toBe("mark");
  });

  it("is not considered when it was undone", () => {
    const withdrawn = { ...ink("a1"), withdrawn: true };
    expect(decide({ annotations: [withdrawn, region("a2")] }).kind).toBe("mark");
  });
});

describe("an empty frame", () => {
  it("asks for a capture, which is how the caller discovers there is no ink", () => {
    /*
     * Nothing to name. The capture path is the only one that can still produce something — and
     * it declines when the frame has no strokes, so this cannot invent a block either.
     */
    expect(decide({}).kind).toBe("capture");
  });

  it("asks for a capture when every mark is already in the request", () => {
    expect(decide({ annotations: [region("a1")], bound: ["a1"] }).kind).toBe("capture");
  });
});

describe("one press, one answer", () => {
  it("never reports two kinds, whatever the state", () => {
    /*
     * The structural reason the duplicate cannot come back: the answer is a single value, so no
     * caller can turn it into two blocks without adding a second one itself.
     */
    const states = [
      { selected: title },
      { annotations: [region("a1")] },
      { annotations: [ink("a1")] },
      { annotations: [region("a1")], bound: ["a1"] },
      { selected: title, annotations: [arrow("a2")], bound: [] },
    ];
    for (const state of states) {
      const action: unknown = decide(state);
      expect(typeof action).toBe("object");
      expect(Object.keys(action as object)).toContain("kind");
    }
  });
});
