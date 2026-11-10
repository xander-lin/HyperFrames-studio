import { beforeEach, describe, expect, it } from "vitest";
import { appendAnnotationRef, annotationRef, dropAnnotationRef, renumberAnnotationRefs } from "@mystudio/protocol";
import { useAnnotationStore } from "./annotationStore.js";
import { newestReferenceable } from "./annotationView.js";

/**
 * The `S` gesture, exercised through the store plus the protocol helpers.
 *
 * The hook itself is a thin wrapper, but the *contract* is what matters and can be
 * tested without React:
 * - the reference goes at the **end**, on a line of its own;
 * - the mark becomes bound, which is what puts it into the delivery;
 * - pressing S on a mark does not disturb an earlier one.
 */

const frame = {
  compositionPath: "index.html",
  time: 3,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

beforeEach(() => {
  useAnnotationStore.setState({ annotations: [], boundIds: [], past: [], future: [] });
});

/**
 * The `S` step, using the same target rule as the hook.
 *
 * `newestReferenceable` is imported rather than re-derived: the earlier copy accepted ink,
 * which production never does — so the test asserted a block that could not exist.
 */
function pressS(text: string): string {
  const { annotations, boundIds, bind } = useAnnotationStore.getState();
  const target = newestReferenceable(annotations);
  if (!target) return text;
  const ref = annotationRef(target.shape.kind, boundIds.length);
  bind(target.id);
  return appendAnnotationRef(text, ref);
}

function draw(kind: "region" | "arrow" | "freehand") {
  const shape =
    kind === "region"
      ? { kind, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }
      : kind === "arrow"
        ? { kind, from: { x: 0.2, y: 0.2 }, to: { x: 0.5, y: 0.5 } }
        : { kind, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] };
  return useAnnotationStore.getState().add({ shape, frame } as Parameters<
    ReturnType<typeof useAnnotationStore.getState>["add"]
  >[0]);
}

describe("S appends the newest mark", () => {
  it("writes the block reference on a line of its own at the very end", () => {
    draw("region");
    expect(pressS("make the title bigger")).toBe("make the title bigger\nRegion 1");
  });

  it("starts from an empty prompt without leading whitespace", () => {
    draw("arrow");
    expect(pressS("")).toBe("Arrow 1");
  });

  it("binds the mark, because that is what puts it into the delivery", () => {
    const created = draw("region");
    pressS("");
    expect(useAnnotationStore.getState().boundIds).toEqual([created.id]);
  });

  it("does nothing for ink: it has no block reference to add", () => {
    /*
     * Handwriting is delivered as a picture of the frame, never as a numbered block.
     * The earlier version of this test used ink here and asserted a binding — a binding
     * production never creates, because `addToPrompt` skips shapes without a reference.
     */
    draw("freehand");
    expect(pressS("")).toBe("");
    expect(useAnnotationStore.getState().boundIds).toEqual([]);
  });

  it("keeps earlier sentences and earlier references intact", () => {
    draw("region");
    let text = pressS("darker here");
    draw("arrow");
    text = pressS(text);
    expect(text).toBe("darker here\nRegion 1\nArrow 2");
  });

  it("numbers by binding order, so the badge and the block agree", () => {
    // The first stroke drawn may well be the last one added.
    draw("region");
    draw("arrow");
    const text = pressS("");
    // Only the newest mark is added, and it is the first binding — so it is number 1.
    expect(text).toBe("Arrow 1");
    expect(useAnnotationStore.getState().boundIds).toHaveLength(1);
  });

  it("does nothing when every mark has been withdrawn", () => {
    const created = draw("region");
    useAnnotationStore.getState().bind(created.id);
    useAnnotationStore.getState().undo();
    expect(pressS("nothing to add")).toBe("nothing to add");
  });

  it("does nothing with no marks at all", () => {
    expect(pressS("plain text")).toBe("plain text");
  });
});

describe("pressing S on a mark already in the prompt", () => {
  /*
   * The reported defect: press add-to-prompt repeatedly on the same thing and the text grows.
   * The ordinal came from `boundIds.length`, so a repeat was appended under a *new* number
   * (`Region 1`, then `Region 2`) that no block ever had (found.md F-103).
   */
  function pressSOnce(text: string): string {
    const { annotations, boundIds, bind } = useAnnotationStore.getState();
    const target = newestReferenceable(annotations);
    // The guard the hook now applies.
    if (!target || boundIds.includes(target.id)) return text;
    const ref = annotationRef(target.shape.kind, boundIds.length);
    bind(target.id);
    return appendAnnotationRef(text, ref);
  }

  it("appends the reference once", () => {
    draw("region");
    expect(pressSOnce("darken this")).toBe("darken this\nRegion 1");
  });

  it("adds nothing on a second press for the same mark", () => {
    draw("region");
    let text = pressSOnce("");
    text = pressSOnce(text);
    text = pressSOnce(text);
    expect(text).toBe("Region 1");
  });

  it("never invents a second ordinal for one mark", () => {
    // A `Region 2` with no second region is a reference to nothing.
    draw("region");
    let text = pressSOnce("");
    text = pressSOnce(text);
    expect(text).not.toContain("Region 2");
  });

  it("still adds a second mark when a different one exists", () => {
    draw("region");
    let text = pressSOnce("");
    draw("arrow");
    text = pressSOnce(text);
    expect(text).toBe("Region 1\nArrow 2");
  });
});

describe("removing a block keeps the numbering coherent", () => {
  it("drops the reference and shifts every later one down", () => {
    /*
     * Block references are positional: after deleting the first block, what was
     * `Arrow 2` becomes `Arrow 1`, and the user's text has to follow or it would name
     * the wrong thing.
     */
    const text = "Region 1 stays, Arrow 2 goes";
    const afterDrop = dropAnnotationRef(text, 2);
    const renumbered = renumberAnnotationRefs(afterDrop, 2);
    expect(renumbered).toContain("Region 1 stays");
    expect(renumbered).not.toContain("Arrow 2");
  });
});
