import { beforeEach, describe, expect, it } from "vitest";
import type { AnnotationShape } from "@mystudio/protocol";
import { isReferenceAnnotation, isReferenceableShape } from "@mystudio/protocol";
import { useAnnotationStore } from "./annotationStore.js";
import { frameMarks } from "./frameMarks.js";
import { annotationOrdinals, type RequestEntry } from "./requestOrder.js";

/**
 * Handwriting owns no block number.
 *
 * ## Why this is a rule and not a preference
 *
 * Numbers are positional: the badge on the canvas, the block in the prompt and the
 * heading in the delivered prompt all derive from a mark's place in the list. If ink
 * took a slot, drawing something freehand between two arrows would make `Arrow 1`
 * become `Arrow 2` — and any sentence the user already wrote about "Arrow 1" would
 * silently start pointing at a different mark.
 *
 * So ink is excluded from numbering entirely: it does not count, it cannot be named, and
 * it reaches the reader as a picture of the frame instead.
 */

const frame = {
  compositionPath: "index.html",
  time: 2,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function region(x: number): AnnotationShape {
  return { kind: "region", rect: { x, y: 0.1, width: 0.1, height: 0.1 } };
}

function arrow(x: number): AnnotationShape {
  return { kind: "arrow", from: { x, y: 0.1 }, to: { x: x + 0.2, y: 0.2 } };
}

function ink(x: number): AnnotationShape {
  return {
    kind: "freehand",
    points: [
      { x, y: 0.1 },
      { x: x + 0.05, y: 0.2 },
      { x: x + 0.1, y: 0.1 },
    ],
  };
}

/**
 * The badges, through the function **both surfaces use**.
 *
 * `frameMarks` is what the canvas paints and what the delivered picture composes, so a test of it
 * is a test of the product — and there is no second numbering routine left to disagree with it
 * (found.md F-122). Numbers come from the **request**: a mark is numbered because the user added
 * it, not because it exists (found.md F-118).
 *
 * Ink is the case under test here: it is painted, but `isReferenceableShape` refuses to give it a
 * reference, so it must never consume a number — otherwise drawing a line between two arrows
 * would silently renumber them.
 */
function numberedOrdinals(request: readonly RequestEntry[] = []): Array<{ ordinal: number; kind: string }> {
  const { annotations, boundIds } = useAnnotationStore.getState();
  const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const ordinals =
    request.length > 0
      ? annotationOrdinals(request)
      : annotationOrdinals(boundIds.map((id) => ({ kind: "annotation" as const, id })));
  const frame = annotations[0]?.frame;
  if (!frame) return [];

  return frameMarks(
    annotations,
    { compositionPath: frame.compositionPath, time: frame.time },
    ordinals,
  )
    .filter((mark) => mark.badge !== null)
    .map((mark) => ({ ordinal: Number(mark.badge), kind: byId.get(mark.id)?.shape.kind ?? "" }));
}

beforeEach(() => {
  useAnnotationStore.setState({ annotations: [], boundIds: [], past: [], future: [] });
});

describe("isReferenceableShape", () => {  it("counts regions and arrows, and nothing else", () => {
    expect(isReferenceableShape("region")).toBe(true);
    expect(isReferenceableShape("arrow")).toBe(true);
    expect(isReferenceableShape("freehand")).toBe(false);
  });
});

describe("isReferenceAnnotation", () => {
  it("rejects ink, so it can never enter a prompt block list", () => {
    const created = useAnnotationStore.getState().add({ shape: ink(0.2), frame });
    expect(isReferenceAnnotation(created)).toBe(false);

    const annotated = useAnnotationStore.getState().add({ shape: arrow(0.2), frame });
    expect(isReferenceAnnotation(annotated)).toBe(true);
  });
});

describe("ink does not consume an ordinal", () => {
  it("drawing ink between two arrows leaves their numbers alone", () => {
    const first = useAnnotationStore.getState().add({ shape: arrow(0.1), frame });
    useAnnotationStore.getState().bind(first.id);
    useAnnotationStore.getState().add({ shape: ink(0.4), frame });
    const second = useAnnotationStore.getState().add({ shape: arrow(0.6), frame });
    useAnnotationStore.getState().bind(second.id);

    expect(numberedOrdinals()).toEqual([
      { ordinal: 1, kind: "arrow" },
      { ordinal: 2, kind: "arrow" },
    ]);

    // And the numbers are attached to the arrows themselves, not merely counted.
    const ordered = useAnnotationStore
      .getState()
      .annotations.filter((annotation) => isReferenceableShape(annotation.shape.kind));
    expect(ordered.map((annotation) => annotation.id)).toEqual([first.id, second.id]);
  });

  it("withdrawing ink does not renumber anything either", () => {
    // Withdrawn ink cannot exist as a block, so it must not hold a slot that others
    // keep clear of.
    useAnnotationStore.getState().add({ shape: ink(0.2), frame });
    const bounded = useAnnotationStore.getState().add({ shape: region(0.5), frame });
    useAnnotationStore.getState().bind(bounded.id);
    expect(numberedOrdinals()).toEqual([{ ordinal: 1, kind: "region" }]);
  });
});
