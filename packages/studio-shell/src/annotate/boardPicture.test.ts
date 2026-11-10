import { describe, expect, it } from "vitest";
import { boardSignature, composeBoardPicture } from "./boardPicture.js";
import type { AnnotationShape } from "@mystudio/protocol";

/**
 * Composing a whiteboard page.
 *
 * The point of these tests: a board picture must be **the page the user was looking at**, at
 * the video's size, with no numbers on it. The canvas is stubbed because this runs in Node —
 * the stub records the calls, which is enough to assert "the paper was filled, then the marks,
 * and no badge was ever drawn".
 */

interface Recorded {
  readonly op: string;
  readonly args: readonly unknown[];
}

function stubCanvas() {
  const calls: Recorded[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", args }),
    strokeRect: (...args: unknown[]) => calls.push({ op: "strokeRect", args }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    arc: (...args: unknown[]) => calls.push({ op: "arc", args }),
    moveTo: (...args: unknown[]) => calls.push({ op: "moveTo", args }),
    lineTo: (...args: unknown[]) => calls.push({ op: "lineTo", args }),
    quadraticCurveTo: (...args: unknown[]) => calls.push({ op: "quadraticCurveTo", args }),
    closePath: () => calls.push({ op: "closePath", args: [] }),
    fill: () => calls.push({ op: "fill", args: [] }),
    stroke: () => calls.push({ op: "stroke", args: [] }),
    fillText: (...args: unknown[]) => calls.push({ op: "fillText", args }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
    setLineDash: () => undefined,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => "data:image/png;base64,QUJD",
  };
  return { canvas, calls };
}

const region: AnnotationShape = {
  kind: "region",
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
};

const freehand: AnnotationShape = {
  kind: "freehand",
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.5 },
  ],
  colour: "#101114",
  width: 3,
};

describe("composeBoardPicture", () => {
  it("fills the page with the paper colour before drawing anything", async () => {
    const { canvas, calls } = stubCanvas();
    const result = await composeBoardPicture(
      { width: 1920, height: 1080, background: "#f6f4ef", shapes: [region], strokeScale: 2 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("fillRect");
    expect(calls[0]?.args).toEqual([0, 0, 1920, 1080]);
  });

  it("draws at the composition's size, not the screen's", async () => {
    /*
     * The rule that keeps the two surfaces interchangeable: a board page is the video's size.
     * A 1920-wide composition produces a 1920-wide picture whatever the window did.
     */
    const { canvas } = stubCanvas();
    await composeBoardPicture(
      { width: 1920, height: 1080, background: "#fff", shapes: [], strokeScale: 1 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it("draws every mark — a box is a sketch too, not only ink", async () => {
    // The same rule as the video's capture: what the user sees is what gets drawn.
    const { canvas, calls } = stubCanvas();
    await composeBoardPicture(
      { width: 800, height: 600, background: "#fff", shapes: [region, freehand], strokeScale: 1 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(calls.some((call) => call.op === "strokeRect")).toBe(true);
    expect(calls.some((call) => call.op === "quadraticCurveTo" || call.op === "lineTo")).toBe(true);
  });

  it("never draws a badge, whatever the page holds", async () => {
    /*
     * The board rule: a page has no prompt, so nothing refers to a shape on it. A number would
     * be an identifier for something that cannot be named, and would also claim the mark
     * occupies a slot in a sequence it is not part of.
     *
     * `fillText` is the probe, not `arc`: ink itself is drawn with arcs (the variable-width
     * renderer walks a curve), so "no arc" would fail on any real stroke. A badge is the only
     * thing on this canvas that writes characters.
     */
    const { canvas, calls } = stubCanvas();
    await composeBoardPicture(
      { width: 800, height: 600, background: "#fff", shapes: [region, freehand], strokeScale: 2 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(calls.some((call) => call.op === "fillText")).toBe(false);
  });

  it("fails honestly when the page has no size", async () => {
    const { canvas } = stubCanvas();
    const result = await composeBoardPicture(
      { width: 0, height: 0, background: "#fff", shapes: [], strokeScale: 1 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(result.ok).toBe(false);
  });

  it("fails honestly when there is no 2D context", async () => {
    const canvas = { width: 0, height: 0, getContext: () => null, toDataURL: () => "" };
    const result = await composeBoardPicture(
      { width: 10, height: 10, background: "#fff", shapes: [], strokeScale: 1 },
      () => canvas as unknown as HTMLCanvasElement,
    );
    expect(result.ok).toBe(false);
  });
});

describe("boardSignature", () => {
  it("is unchanged when nothing changed", () => {
    // Pressing Ctrl+S twice must add one block, so the signature has to be stable.
    expect(boardSignature([region, freehand])).toBe(boardSignature([region, freehand]));
  });

  it("changes when a stroke is added", () => {
    expect(boardSignature([region])).not.toBe(boardSignature([region, freehand]));
  });

  it("changes when a stroke's colour changes", () => {
    const darker: AnnotationShape = { ...freehand, colour: "#ff0000" };
    expect(boardSignature([freehand])).not.toBe(boardSignature([darker]));
  });

  it("changes when a box moves, even though its kind did not", () => {
    // A kind-only signature would call a moved box "nothing changed".
    const moved: AnnotationShape = {
      kind: "region",
      rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
    };
    expect(boardSignature([region])).not.toBe(boardSignature([moved]));
  });

  it("does not distinguish two pages that happen to look alike", () => {
    /*
     * This is deliberate: the page key is combined with this string by the caller. Mixing the
     * key in here would make the signature depend on something that is not the picture.
     */
    expect(boardSignature([region])).toBe(boardSignature([region]));
  });
});
