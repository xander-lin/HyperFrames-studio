import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationShape } from "@mystudio/protocol";
import { newestReferenceable } from "./annotationView.js";

/**
 * The derived views: one order, read by the canvas.
 *
 * The canvas badges and the delivered headings both derive from these functions. The point of
 * testing them here is that the components no longer each carry
 * their own copy of the ordering rule.
 */

const frame = {
  compositionPath: "index.html",
  time: 1,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

function annotation(id: string, shape: AnnotationShape, withdrawn = false): Annotation {
  /*
   * `seq` is the position in the request's shared block sequence — the number the badge shows.
   * A mark without one has not been added to a request yet and sorts last, so fixtures that
   * exercise numbering must set it (found.md F-111).
   */
  return {
    id,
    shape,
    frame,
    note: "",
    createdAt: Number(id.slice(1)),
    seq: Number(id.slice(1)),
    ...(withdrawn ? { withdrawn } : {}),
  };
}

const region = (id: string, withdrawn = false): Annotation =>
  annotation(id, { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }, withdrawn);

const arrow = (id: string, withdrawn = false): Annotation =>
  annotation(id, { kind: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.6 } }, withdrawn);

const ink = (id: string): Annotation =>
  annotation(id, { kind: "freehand", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });

/*
 * Painting order and badge numbering are not here any more.
 *
 * Both moved to `frameMarks`, because the canvas and the delivered picture must read **one**
 * answer instead of each computing for itself — that duplication is what let the delivered image
 * show a numbered mark the screen did not have (found.md F-122). What remains in this module is
 * "which mark would `S` name", which is what the tests below cover.
 */
describe("newestReferenceable", () => {
  it("returns the last mark a sentence can name", () => {
    expect(newestReferenceable([region("a1"), arrow("a2")])?.id).toBe("a2");
  });

  it("skips ink, which has no block reference", () => {
    expect(newestReferenceable([region("a1"), ink("a2")])?.id).toBe("a1");
    expect(newestReferenceable([ink("a1")])).toBeNull();
  });

  it("skips withdrawn marks: the user already said they are gone", () => {
    expect(newestReferenceable([region("a1"), arrow("a2", true)])?.id).toBe("a1");
  });

  it("returns null when there is nothing to name", () => {
    expect(newestReferenceable([])).toBeNull();
  });
});
