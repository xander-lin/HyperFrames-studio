/**
 * Annotation tool state machine.
 *
 * Deliberately a **pure object with no React dependency**: it can be tested alone
 * and reused outside Studio (a future standalone preview window, say).
 *
 * Lifecycle:
 *   idle → (pick a drawing tool) → drawing → (release) → idle
 *
 * There is **no drafting step**. A finished stroke is a real annotation
 * immediately: it stays on the frame, and pressing `S` is what puts it into the
 * prompt. Requiring the user to confirm every stroke in a popup was friction with
 * no payoff — a stroke the user just drew is by definition the stroke they meant.
 *
 * The eraser and the select tool are not drawing tools: they never enter the
 * `drawing` state, so the state machine stays about points only.
 */

import type { AnnotationShape, InkPoint, Point } from "@mystudio/protocol";
import type { PenStyle } from "./penStyle.js";

/** Re-exported because a stroke's pen is part of the drawing state, not the toolbar. */
export type { PenStyle } from "./penStyle.js";

export type AnnotationTool = "select" | "region" | "arrow" | "freehand" | "eraser";

/** The tools that produce a shape by dragging. */
export type DrawingTool = Exclude<AnnotationTool, "select" | "eraser">;

export interface DrawingState {
  readonly status: "drawing";
  readonly tool: DrawingTool;
  /**
   * Confirmed samples. Region and arrow use first+last; freehand keeps every one,
   * including its pressure, because the stroke is re-rendered at other sizes later.
   */
  readonly points: readonly InkPoint[];
  /**
   * Pen choices for this stroke.
   *
   * Captured when the stroke **starts**, not read from the toolbar when it ends. The
   * user may change the pen colour between strokes; a stroke must keep the pen it was
   * drawn with, or switching colour would retroactively repaint earlier writing.
   */
  readonly pen?: PenStyle;
}

export interface IdleState {
  readonly status: "idle";
  readonly tool: AnnotationTool;
}

export type EditorState = IdleState | DrawingState;

/** Normalized threshold below which a gesture counts as "too small" and is dropped. */
export const MIN_GESTURE_EXTENT = 0.005;

export function idle(tool: AnnotationTool = "select"): IdleState {
  return { status: "idle", tool };
}

/** Switching tools abandons the gesture in progress — no progress is worth keeping. */
export function selectTool(_state: EditorState, tool: AnnotationTool): EditorState {
  return idle(tool);
}

/** Whether a tool draws by dragging. */
export function isDrawingTool(tool: AnnotationTool): tool is DrawingTool {
  return tool === "region" || tool === "arrow" || tool === "freehand";
}

/**
 * Begin a stroke.
 *
 * Returns `EditorState` rather than `DrawingState`: with a non-drawing tool, or
 * while a stroke is already in flight, this press does not start anything and the
 * caller seeing "not drawing" should do nothing.
 */
export function beginStroke(state: EditorState, point: InkPoint, pen?: PenStyle): EditorState {
  if (state.status === "drawing") return state;
  if (!isDrawingTool(state.tool)) return state;
  return pen
    ? { status: "drawing", tool: state.tool, points: [point], pen }
    : { status: "drawing", tool: state.tool, points: [point] };
}

export function extendStroke(state: DrawingState, point: InkPoint): DrawingState {
  // freehand records every sample; region/arrow only need the endpoints, so the
  // first point plus the newest one replaces the list.
  if (state.tool === "freehand") {
    return { ...state, points: [...state.points, point] };
  }
  const first = state.points[0] ?? point;
  // Region and arrow do not carry pressure: they are a rectangle and a line, not ink,
  // and a thickness that varied along a straight line would just look like a mistake.
  return { ...state, points: [withoutPressure(first), withoutPressure(point)] };
}

/** Drop `pressure` from a sample used by a shape that has no ink thickness. */
function withoutPressure(point: InkPoint): InkPoint {
  return { x: point.x, y: point.y };
}

/**
 * Quantize to 1/10000.
 *
 * Canvas coordinates are floats: `0.8 - 0.2` is `0.6000000000000001` in double
 * precision. Annotations get serialized, delivered and re-rendered, so the noise
 * accumulates until equality checks and snapshot tests fail. Canvas precision never
 * needs 1e-16; four decimals is plenty (about 0.2px at 1920 wide).
 */
function quantize(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function normalizeRect(a: Point, b: Point): AnnotationShape {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    kind: "region",
    rect: {
      x: quantize(x),
      y: quantize(y),
      width: quantize(Math.abs(b.x - a.x)),
      height: quantize(Math.abs(b.y - a.y)),
    },
  };
}

/**
 * Finish a gesture and produce the shape to keep on the frame.
 *
 * Returning null means the gesture was too small to be anything — a click, a
 * twitch — so the caller just returns to idle instead of creating a stray mark.
 */
export function finishStroke(state: DrawingState): AnnotationShape | null {
  const first = state.points[0];
  const last = state.points[state.points.length - 1];
  if (!first || !last) return null;

  if (state.tool === "region") {
    const shape = normalizeRect(first, last);
    if (shape.kind !== "region") return null;
    if (shape.rect.width < MIN_GESTURE_EXTENT && shape.rect.height < MIN_GESTURE_EXTENT) return null;
    return shape;
  }

  if (state.tool === "arrow") {
    const dx = Math.abs(last.x - first.x);
    const dy = Math.abs(last.y - first.y);
    if (dx < MIN_GESTURE_EXTENT && dy < MIN_GESTURE_EXTENT) return null;
    return { kind: "arrow", from: first, to: last };
  }

  // freehand: too few points or a stroke with no extent gets dropped.
  const ink = condenseInk(state.points);
  if (ink.length < 2) return null;
  const xs = ink.map((p) => p.x);
  const ys = ink.map((p) => p.y);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (extent < MIN_GESTURE_EXTENT) return null;
  return {
    kind: "freehand",
    points: ink,
    ...(state.pen ? { colour: state.pen.colour, width: state.pen.width } : {}),
  };
}

/**
 * Turn raw pointer samples into stored ink.
 *
 * Three things happen here, and each exists because of how a real pen behaves:
 *
 * 1. **Duplicates are dropped.** A digitizer reports far more samples than the eye can
 *    see — easily 200 per second — and a stationary pen keeps emitting the same
 *    position. Keeping them would triple the stored size and make every later pass
 *    (hit testing, rendering) walk points that add nothing.
 * 2. **Coordinates are quantized**, for the same reason rectangles and arrows are: the
 *    stored value gets serialized and re-rendered, and float noise accumulates.
 * 3. **Pressure is kept, but only when it was really measured.** A mouse reports a flat
 *    0.5; storing that would tell the renderer "this was a medium press" for every
 *    stroke, and the line would come out uniformly thick instead of like handwriting.
 *    Absent means "unknown", which the renderer reads as "use the plain width".
 */
function condenseInk(points: readonly InkPoint[]): InkPoint[] {
  const kept: InkPoint[] = [];
  for (const point of points) {
    const x = quantize(point.x);
    const y = quantize(point.y);
    const previous = kept[kept.length - 1];
    if (previous && previous.x === x && previous.y === y) {
      // Same place as the previous sample: keep the newer pressure, drop the duplicate.
      if (point.pressure !== undefined) kept[kept.length - 1] = { x, y, pressure: clampPressure(point.pressure) };
      continue;
    }
    kept.push(
      point.pressure === undefined
        ? { x, y }
        : { x, y, pressure: clampPressure(point.pressure) },
    );
  }
  return kept;
}

function clampPressure(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Cancel: any state returns to idle, keeping the current tool so drawing can continue. */
export function cancel(state: EditorState): IdleState {
  return idle(state.tool);
}
