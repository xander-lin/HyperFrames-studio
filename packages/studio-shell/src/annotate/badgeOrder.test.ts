import { beforeEach, describe, expect, it } from "vitest";
import type { AnnotationShape } from "@mystudio/protocol";
import { useAnnotationStore } from "./annotationStore.js";
import { frameMarks } from "./frameMarks.js";
import { annotationOrdinals, type RequestEntry } from "./requestOrder.js";

/**
 * A withdrawn mark keeps its number but stops being painted.
 *
 * ## Why this is a rule and not a detail
 *
 * Undoing a mark that is already in the prompt does **not** remove its block: the user's
 * sentence still says `Arrow 2`, so removing the block would renumber everything after it and
 * silently change what their sentence points at. The mark is instead marked `withdrawn` — the
 * block stays (and turns red in the box), and the picture stops showing it.
 *
 * That is two facts about one mark, and they live in two places on purpose:
 *
 * - **the number** is its position in the request (`annotationOrdinals`);
 * - **whether it is painted** is `frameMarks`, which skips withdrawn marks.
 *
 * The tests here are against those two real functions — a test that re-implemented the ordering
 * kept passing while the mount point drifted away from it, which is exactly how the canvas and
 * the delivered picture came to disagree (found.md F-122).
 */

const frame = {
  compositionPath: "index.html",
  time: 0,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function shape(kind: "region" | "arrow", x: number): AnnotationShape {
  return kind === "region"
    ? { kind, rect: { x, y: 0.1, width: 0.1, height: 0.1 } }
    : { kind, from: { x, y: 0.1 }, to: { x: x + 0.2, y: 0.1 } };
}

beforeEach(() => {
  useAnnotationStore.setState({ annotations: [], boundIds: [], past: [], future: [] });
});

/** The request as the hook would hold it: every bound mark, in binding order. */
function request(): RequestEntry[] {
  const { annotations, boundIds } = useAnnotationStore.getState();
  return boundIds
    .map((id) => annotations.find((annotation) => annotation.id === id))
    .filter((annotation) => annotation !== undefined)
    .map((annotation) => ({
      kind: "annotation" as const,
      id: annotation.id,
      shape: annotation.shape.kind,
    }));
}

/** What is painted on this frame, with badges, through the shared function. */
function painted(): Array<{ id: string; badge: string | null }> {
  const { annotations } = useAnnotationStore.getState();
  return frameMarks(annotations, frame, annotationOrdinals(request())).map((mark) => ({
    id: mark.id,
    badge: mark.badge,
  }));
}

describe("a withdrawn mark", () => {
  it("stops being painted but keeps its number", () => {
    const first = useAnnotationStore.getState().add({ shape: shape("region", 0.1), frame });
    const second = useAnnotationStore.getState().add({ shape: shape("arrow", 0.4), frame });
    useAnnotationStore.getState().bind(first.id);
    useAnnotationStore.getState().bind(second.id);

    // Undo the arrow: it is bound, so it is withdrawn rather than deleted.
    useAnnotationStore.getState().undo();

    // Only the region is painted…
    expect(painted()).toEqual([{ id: first.id, badge: "1" }]);

    // …and the arrow still answers to `Arrow 2`, so nothing after it shifts.
    expect(annotationOrdinals(request()).get(second.id)).toBe(2);
  });

  it("does not shift the badges of the marks after it", () => {
    const a = useAnnotationStore.getState().add({ shape: shape("region", 0.1), frame });
    const b = useAnnotationStore.getState().add({ shape: shape("region", 0.4), frame });
    const c = useAnnotationStore.getState().add({ shape: shape("region", 0.7), frame });
    for (const id of [a.id, b.id, c.id]) useAnnotationStore.getState().bind(id);

    // Withdraw the middle one.
    useAnnotationStore.setState((state) => ({
      annotations: state.annotations.map((annotation) =>
        annotation.id === b.id ? { ...annotation, withdrawn: true } : annotation,
      ),
    }));

    // Two marks painted, and the third one is still `3`.
    expect(painted()).toEqual([
      { id: a.id, badge: "1" },
      { id: c.id, badge: "3" },
    ]);
  });

  it("leaves no slot behind when it was never in the request", () => {
    // Never added to the prompt: nothing names it, so an undo removes it outright.
    useAnnotationStore.getState().add({ shape: shape("region", 0.1), frame });
    useAnnotationStore.getState().add({ shape: shape("region", 0.4), frame });
    useAnnotationStore.getState().undo();

    expect(painted()).toHaveLength(1);
    expect(request()).toHaveLength(0);
  });
});
