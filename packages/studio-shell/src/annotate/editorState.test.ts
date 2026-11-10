import { describe, expect, it } from "vitest";
import {
  MIN_GESTURE_EXTENT,
  beginStroke,
  cancel,
  extendStroke,
  finishStroke,
  idle,
  isDrawingTool,
  selectTool,
} from "./editorState.js";

/**
 * The tool state machine.
 *
 * The important change from the earlier design: finishing a stroke produces a
 * **shape to keep**, not a draft awaiting confirmation. There is no drafting state,
 * so no test here should expect one.
 */

describe("idle / selectTool", () => {
  it("starts on the select tool so Studio behaves normally by default", () => {
    expect(idle().tool).toBe("select");
  });

  it("switching tools returns to idle", () => {
    expect(selectTool(idle("region"), "arrow")).toMatchObject({ status: "idle", tool: "arrow" });
  });

  it("switching tools abandons an in-progress stroke", () => {
    const drawing = extendStroke(beginStroke(idle("region"), { x: 0.1, y: 0.1 }), { x: 0.5, y: 0.5 });
    expect(drawing.status).toBe("drawing");
    expect(selectTool(drawing, "freehand")).toMatchObject({ status: "idle", tool: "freehand" });
  });
});

describe("isDrawingTool", () => {
  it("counts only the three shape tools", () => {
    expect(isDrawingTool("region")).toBe(true);
    expect(isDrawingTool("arrow")).toBe(true);
    expect(isDrawingTool("freehand")).toBe(true);
    // The eraser and select act on existing marks; they never start a stroke.
    expect(isDrawingTool("eraser")).toBe(false);
    expect(isDrawingTool("select")).toBe(false);
  });
});

describe("beginStroke", () => {
  it("does not capture strokes while the select tool is active", () => {
    // Dragging with the select tool belongs to Studio (element selection, marquee);
    // the annotation layer must not take it.
    expect(beginStroke(idle("select"), { x: 0.5, y: 0.5 }).status).toBe("idle");
  });

  it("does not capture strokes while the eraser is active", () => {
    // The eraser erases on press; it must not also start painting a line.
    expect(beginStroke(idle("eraser"), { x: 0.5, y: 0.5 }).status).toBe("idle");
  });

  it("starts drawing with the active tool", () => {
    expect(beginStroke(idle("region"), { x: 0.2, y: 0.3 })).toEqual({
      status: "drawing",
      tool: "region",
      points: [{ x: 0.2, y: 0.3 }],
    });
  });

  it("ignores a press while already drawing, so two pointers cannot interleave", () => {
    const drawing = beginStroke(idle("arrow"), { x: 0.1, y: 0.1 });
    expect(beginStroke(drawing, { x: 0.9, y: 0.9 })).toBe(drawing);
  });
});

describe("extendStroke", () => {
  it("keeps every sampled point for freehand", () => {
    let state = beginStroke(idle("freehand"), { x: 0, y: 0 });
    state = extendStroke(state, { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.2, y: 0.15 });
    expect(state.status).toBe("drawing");
    if (state.status === "drawing") expect(state.points).toHaveLength(3);
  });

  it("keeps only head and tail for region, because a rectangle needs just two corners", () => {
    let state = beginStroke(idle("region"), { x: 0, y: 0 });
    state = extendStroke(state, { x: 0.3, y: 0.3 });
    state = extendStroke(state, { x: 0.5, y: 0.6 });
    if (state.status !== "drawing") throw new Error("expected drawing");
    expect(state.points).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
    ]);
  });

  it("tracks the moving end for an arrow without accumulating points", () => {
    let state = beginStroke(idle("arrow"), { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.4, y: 0.4 });
    state = extendStroke(state, { x: 0.9, y: 0.8 });
    if (state.status !== "drawing") throw new Error("expected drawing");
    expect(state.points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.8 },
    ]);
  });
});

describe("finishStroke — region", () => {
  it("normalises a drag in any direction into a positive rect", () => {
    // Dragged from bottom-right to top-left: width/height must stay positive, or the
    // drawing layer paints an empty rect.
    let state = beginStroke(idle("region"), { x: 0.8, y: 0.7 });
    state = extendStroke(state, { x: 0.2, y: 0.3 });
    expect(finishStroke(state as Parameters<typeof finishStroke>[0])).toEqual({
      kind: "region",
      rect: { x: 0.2, y: 0.3, width: 0.6, height: 0.4 },
    });
  });

  it("discards a click that produced no area", () => {
    const state = beginStroke(idle("region"), { x: 0.5, y: 0.5 });
    const extended = extendStroke(state, { x: 0.5005, y: 0.5005 });
    expect(finishStroke(extended as Parameters<typeof finishStroke>[0])).toBeNull();
  });
});

describe("finishStroke — arrow", () => {
  it("produces a from/to arrow, keeping tail and head distinct", () => {
    let state = beginStroke(idle("arrow"), { x: 0.2, y: 0.2 });
    state = extendStroke(state, { x: 0.75, y: 0.6 });
    expect(finishStroke(state as Parameters<typeof finishStroke>[0])).toEqual({
      kind: "arrow",
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.75, y: 0.6 },
    });
  });

  it("discards an arrow with no visible length", () => {
    const state = beginStroke(idle("arrow"), { x: 0.5, y: 0.5 });
    const extended = extendStroke(state, { x: 0.5001, y: 0.5001 });
    expect(finishStroke(extended as Parameters<typeof finishStroke>[0])).toBeNull();
  });
});

describe("finishStroke — freehand", () => {
  it("keeps the full polyline", () => {
    let state = beginStroke(idle("freehand"), { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.2, y: 0.2 });
    state = extendStroke(state, { x: 0.4, y: 0.3 });
    const shape = finishStroke(state as Parameters<typeof finishStroke>[0]);
    expect(shape?.kind).toBe("freehand");
    if (shape?.kind === "freehand") expect(shape.points).toHaveLength(3);
  });

  it("keeps the pressure of every sample, so the stroke can be re-rendered like handwriting", () => {
    /*
     * The stored stroke is re-painted later — in the app at another zoom, and into the
     * delivered image. If pressure were dropped at finish time, the taper would exist
     * while drawing and vanish on release.
     */
    let state = beginStroke(idle("freehand"), { x: 0.1, y: 0.1, pressure: 0.2 });
    state = extendStroke(state, { x: 0.2, y: 0.15, pressure: 0.9 });
    state = extendStroke(state, { x: 0.35, y: 0.2, pressure: 0.4 });
    const shape = finishStroke(state as Parameters<typeof finishStroke>[0]);
    if (shape?.kind !== "freehand") throw new Error("expected freehand");
    expect(shape.points.map((point) => point.pressure)).toEqual([0.2, 0.9, 0.4]);
  });

  it("stores no pressure at all for a mouse stroke", () => {
    /*
     * A mouse cannot measure pressure. Writing a made-up 0.5 would make the renderer
     * treat every mouse stroke as a medium press: uniformly thick, and identical to the
     * "pressure is broken" symptom.
     */
    let state = beginStroke(idle("freehand"), { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.3, y: 0.3 });
    const shape = finishStroke(state as Parameters<typeof finishStroke>[0]);
    if (shape?.kind !== "freehand") throw new Error("expected freehand");
    for (const point of shape.points) expect("pressure" in point).toBe(false);
  });

  it("drops samples the pen reported without moving", () => {
    // A resting digitizer emits the same position many times a second; keeping them
    // would inflate every stored stroke for no visible gain.
    let state = beginStroke(idle("freehand"), { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.1, y: 0.1 });
    state = extendStroke(state, { x: 0.3, y: 0.3 });
    const shape = finishStroke(state as Parameters<typeof finishStroke>[0]);
    if (shape?.kind !== "freehand") throw new Error("expected freehand");
    expect(shape.points).toHaveLength(2);
  });

  it("does not leak pressure into a region or an arrow", () => {
    /*
     * They are a rectangle and a line, not ink. A width that varied along a straight
     * shaft would read as a rendering glitch, not as a press.
     */
    let arrow = beginStroke(idle("arrow"), { x: 0.1, y: 0.1, pressure: 0.2 });
    arrow = extendStroke(arrow, { x: 0.5, y: 0.5, pressure: 0.9 });
    const arrowShape = finishStroke(arrow as Parameters<typeof finishStroke>[0]);
    if (arrowShape?.kind !== "arrow") throw new Error("expected arrow");
    expect("pressure" in arrowShape.from).toBe(false);
    expect("pressure" in arrowShape.to).toBe(false);

    let region = beginStroke(idle("region"), { x: 0.1, y: 0.1, pressure: 0.2 });
    region = extendStroke(region, { x: 0.5, y: 0.5, pressure: 0.9 });
    const regionShape = finishStroke(region as Parameters<typeof finishStroke>[0]);
    expect(regionShape?.kind).toBe("region");
  });

  it("discards a single-point tap", () => {
    const state = beginStroke(idle("freehand"), { x: 0.5, y: 0.5 });
    expect(finishStroke(state as Parameters<typeof finishStroke>[0])).toBeNull();
  });

  it("discards a scribble that never moved far enough to be visible", () => {
    let state = beginStroke(idle("freehand"), { x: 0.5, y: 0.5 });
    state = extendStroke(state, { x: 0.5 + MIN_GESTURE_EXTENT / 4, y: 0.5 });
    state = extendStroke(state, { x: 0.5, y: 0.5 + MIN_GESTURE_EXTENT / 4 });
    expect(finishStroke(state as Parameters<typeof finishStroke>[0])).toBeNull();
  });
});

describe("cancel", () => {
  it("returns to idle and keeps the drawing tool for the next stroke", () => {
    const drawing = beginStroke(idle("freehand"), { x: 0.1, y: 0.1 });
    expect(cancel(drawing)).toMatchObject({ status: "idle", tool: "freehand" });
  });

  it("preserves the selected tool when already idle", () => {
    expect(cancel(idle("arrow"))).toMatchObject({ status: "idle", tool: "arrow" });
  });
});
