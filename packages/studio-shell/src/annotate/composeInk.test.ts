import { describe, expect, it } from "vitest";
import { composeInk, inkScaleForFrame } from "./composeInk.js";
import type { FreehandAnnotation } from "@mystudio/protocol";

/**
 * Composing the annotated frame.
 *
 * The point of this module is that handwriting reaches the reader **as a picture**, not
 * as a list of points. So what is tested is that it really draws onto the captured frame,
 * at the frame's own size, and that it fails honestly instead of producing a blank image
 * that looks like the user drew nothing.
 *
 * The canvas is stubbed: this runs in Node, and a real 2D context is not available. The
 * stub records the calls, which is enough to assert "the frame was drawn, then the
 * strokes, then a PNG came out".
 */

interface Recorded {
  readonly op: string;
  readonly args: readonly unknown[];
}

function stubCanvas() {
  const calls: Recorded[] = [];
  const ctx = {
    fillStyle: "",
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    arc: (...args: unknown[]) => calls.push({ op: "arc", args }),
    moveTo: (...args: unknown[]) => calls.push({ op: "moveTo", args }),
    lineTo: (...args: unknown[]) => calls.push({ op: "lineTo", args }),
    closePath: () => calls.push({ op: "closePath", args: [] }),
    fill: () => calls.push({ op: "fill", args: [] }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => "data:image/png;base64,QUJD",
  };
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  return { calls, canvas };
}

const stroke: FreehandAnnotation = {
  kind: "freehand",
  points: [
    { x: 0.1, y: 0.1, pressure: 0.2 },
    { x: 0.2, y: 0.2, pressure: 0.8 },
    { x: 0.3, y: 0.1, pressure: 0.4 },
  ],
};

/** Pretend the capture decoded into a 1920×1080 image. */
function fakeImage() {
  return Promise.resolve({ naturalWidth: 1920, naturalHeight: 1080 } as HTMLImageElement);
}

describe("composeInk draws every kind of mark", () => {
  /** A fake canvas that records the drawing primitives used. */
  function recorder() {
    const calls: string[] = [];
    const ctx = {
      drawImage: () => calls.push("frame"),
      fillRect: () => calls.push("fillRect"),
      strokeRect: () => calls.push("strokeRect"),
      beginPath: () => calls.push("beginPath"),
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      arc: () => {},
      fill: () => calls.push("fill"),
      stroke: () => calls.push("stroke"),
      save: () => {},
      restore: () => {},
      setFillStyle: () => {},
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      fillText: () => calls.push("badge"),
    };
    return { ctx, calls };
  }

  function installCanvas(ctx: unknown) {
    const previous = (globalThis as { document?: unknown }).document;
    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ctx,
          toDataURL: () => "data:image/png;base64,AAAA",
        }),
      },
      configurable: true,
      writable: true,
    });
    return () => {
      Object.defineProperty(globalThis, "document", { value: previous, configurable: true, writable: true });
    };
  }

  const image = async () => ({ naturalWidth: 100, naturalHeight: 50 });

  it("draws an arrow, not just the ink", async () => {
    /*
     * The reported defect: "截图的时候，什么箭头、选区框全都看不见" — the composer accepted only
     * handwriting, so a delivered picture disagreed with what the user was looking at
     * (found.md F-110).
     */
    const { ctx, calls } = recorder();
    const restore = installCanvas(ctx);
    try {
      const result = await composeInk(
        {
          framePngBase64: "AAAA",
          shapes: [{ kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 } }],
          strokeScale: 1,
        },
        image,
      );
      expect(result.ok).toBe(true);
      expect(calls).toContain("stroke");
    } finally {
      restore();
    }
  });

  it("draws a region outline", async () => {
    const { ctx, calls } = recorder();
    const restore = installCanvas(ctx);
    try {
      await composeInk(
        {
          framePngBase64: "AAAA",
          shapes: [{ kind: "region", rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
          strokeScale: 1,
        },
        image,
      );
      expect(calls).toContain("strokeRect");
      expect(calls).toContain("fillRect");
    } finally {
      restore();
    }
  });

  it("draws a badge for a numbered shape", async () => {
    const { ctx, calls } = recorder();
    const restore = installCanvas(ctx);
    try {
      await composeInk(
        {
          framePngBase64: "AAAA",
          shapes: [{ kind: "region", rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
          badges: ["2"],
          strokeScale: 1,
        },
        image,
      );
      expect(calls).toContain("badge");
    } finally {
      restore();
    }
  });
});

describe("composeInk", () => {
  it("draws the frame first, then the strokes, and returns the PNG", async () => {
    const { calls, canvas } = stubCanvas();
    const result = await composeInk(
      { framePngBase64: "AAAA", shapes: [stroke], strokeScale: 2 },
      fakeImage,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The data-URL prefix is stripped: the bridge expects raw base64.
    expect(result.pngBase64).toBe("QUJD");

    expect(calls[0]?.op).toBe("drawImage");
    expect(calls.filter((call) => call.op === "fill").length).toBeGreaterThan(0);
    // Rendered at the composition's own size, not the window's.
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
  });

  it("places the ink in frame coordinates, not screen coordinates", async () => {
    /*
     * The stroke is normalized, so its first point must land at 10% of 1920 — not at
     * 0.1 pixels. Getting this wrong would pile every delivered stroke into the top-left
     * corner, which looks like the pen never moved.
     */
    const { calls } = stubCanvas();
    await composeInk({ framePngBase64: "AAAA", shapes: [stroke], strokeScale: 1 }, fakeImage);

    const moves = calls.filter((call) => call.op === "moveTo");
    const xs = moves.map((call) => Number(call.args[0]));
    expect(Math.min(...xs)).toBeGreaterThan(100);
    expect(Math.max(...xs)).toBeLessThan(1920);
  });

  it("paints a halo under the ink so it stays visible on a white slide", async () => {
    // Two passes per segment: a wide dark one, then the coloured one.
    const { calls } = stubCanvas();
    await composeInk({ framePngBase64: "AAAA", shapes: [stroke], strokeScale: 1 }, fakeImage);
    expect(calls.filter((call) => call.op === "fill").length).toBeGreaterThan(4);
  });

  it("still produces the picture when there is no ink at all", async () => {
    // A frame captured for a numbered mark that happens to share the composition.
    const { calls } = stubCanvas();
    const result = await composeInk({ framePngBase64: "AAAA", shapes: [], strokeScale: 1 }, fakeImage);
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("drawImage");
  });

  it("fails with a message when the capture cannot be decoded", async () => {
    /* 
     * Silently producing a blank image would tell the user their handwriting was sent
     * when nothing but an empty frame arrived. Failure has to be visible.
     */
    stubCanvas();
    const result = await composeInk(
      { framePngBase64: "AAAA", shapes: [stroke], strokeScale: 1 },
      () => Promise.reject(new Error("broken png")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("broken png");
  });

  it("fails when the frame reports no size", async () => {
    stubCanvas();
    const result = await composeInk(
      { framePngBase64: "AAAA", shapes: [stroke], strokeScale: 1 },
      () => Promise.resolve({ naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement),
    );
    expect(result.ok).toBe(false);
  });
});

describe("inkScaleForFrame", () => {
  it("scales stroke width by the ratio of image to preview", () => {
    // A 2px stroke on a 480px preview must be 8px in a 1920px image.
    expect(inkScaleForFrame(480, 1920)).toBeCloseTo(4);
  });

  it("never scales below 0.25 or above 8", () => {
    // A wildly different window must not make the ink invisible or a blob.
    expect(inkScaleForFrame(1, 100000)).toBe(8);
    expect(inkScaleForFrame(100000, 1)).toBe(0.25);
  });

  it("falls back to 1 for a degenerate size", () => {
    expect(inkScaleForFrame(0, 1920)).toBe(1);
    expect(inkScaleForFrame(480, 0)).toBe(1);
  });
});
