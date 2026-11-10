/**
 * The annotation drawing layer.
 *
 * A transparent canvas stacked over the preview iframe. It is a separate layer
 * rather than drawing into the iframe because:
 * - inside the iframe the composition's own CSS could affect it, and it might get
 *   rendered into the output;
 * - outside, we control pointer events, zoom and export precisely.
 *
 * Coordinates are always reported normalized and multiplied by the real size when
 * painting, so resizing the window never distorts existing annotations.
 *
 * ## Marks stay on the frame
 *
 * A finished stroke is painted here for as long as it exists — it is not a transient
 * gesture that disappears on release. Undo removes it, the eraser removes it,
 * nothing else does.
 *
 * A **withdrawn** mark (undone while its block was already in the prompt) is not
 * painted at all. It is gone from the picture — that is what undoing a drawing means.
 * Its block stays in the prompt, though, and turns red there; that red block is the
 * only remaining trace, which is exactly the message: "you are referring to something
 * you deleted". The positions still count it, so every later badge keeps its number.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationShape, InkPoint, Point } from "@mystudio/protocol";
import type { AnnotationTool, EditorState } from "./editorState.js";
import { beginStroke, cancel, extendStroke, finishStroke, idle } from "./editorState.js";
import type { PenStyle } from "./penStyle.js";
import { ERASER_RADIUS_PX } from "./eraser.js";
import { paintInk } from "./ink.js";
import { cursorForTool } from "./cursors.js";
import { ANNOTATION_LAYERS } from "./layers.js";
import {
  drawArrow,
  paintShape,
  STROKE,
  STROKE_HALO,
} from "./shapePainter.js";
import { releaseFieldFocus } from "./focusRelease.js";
import type { FrameMark } from "./frameMarks.js";
import type { BoardMark } from "./boardStore.js";

/**
 * A mark that lives on a board rather than on the video.
 *
 * Re-exported from the board store, which owns the data. Two declarations of the same
 * shape would be two things that can drift apart.
 */
export type { BoardMark } from "./boardStore.js";

export interface AnnotationCanvasProps {
  /** Pixel rect of the preview stage (relative to the viewport), used to normalize mouse input. */
  readonly stageRect: { left: number; top: number; width: number; height: number } | null;
  readonly tool: AnnotationTool;
  /**
   * What to paint on this frame, each with its badge.
   *
   * Computed by `frameMarks`, which is the **same function the delivered picture uses**. That is
   * the point: the screen and the picture cannot disagree about which marks are on the frame or
   * what number each carries, because both read one answer (found.md F-122).
   */
  readonly frameMarks: readonly FrameMark[];
  /** Pen chosen in the toolbar, applied to new strokes. */
  readonly pen?: PenStyle;
  /**
   * Board mode: the canvas paints a blank page instead of the video and holds no marks.
   *
   * There is no stage to annotate on a page — the page **is** the surface — so the whole
   * viewport becomes the drawing area. Video marks are not passed in at all, which is
   * what makes "clearing the board does not touch the video" true by construction rather
   * than by remembering to filter.
   */
  readonly board?: {
    /** The page's ink, already filtered to this page. */
    readonly marks: readonly BoardMark[];
    /** Page background, so the board reads as paper rather than as a dark hole. */
    readonly background: string;
  } | null;
  /** Called when a stroke ends. The stroke is already permanent by then. */
  readonly onStroke: (shape: AnnotationShape) => void;
  /** Called when the eraser clicks a point; `tolerance` is normalized to the stage. */
  readonly onErase: (point: Point, tolerance: number) => void;
}

/*
 * The drawing itself lives in `shapePainter.ts`.
 *
 * The canvas and the composed capture must paint a shape **identically**, so there is one
 * implementation and both call it. Keeping a private copy here is how the delivered picture
 * ended up missing arrows and with invisible ink: the two copies had drifted, and only one of
 * them was ever looked at (found.md F-115).
 */
/**
 * Paint the gesture currently under the pointer.
 *
 * Shared by the video and the board for the same reason `paintShape` is: a box being
 * dragged is a box, whichever surface it is being dragged on.
 */
function paintGesture(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  toPixels: (point: InkPoint) => InkPoint,
  lineWidth: number,
): void {
  if (state.status !== "drawing") return;

  const points = state.points.map(toPixels);
  if (state.tool === "freehand") {
    // Same rendering as the finished stroke, so nothing "snaps" on release.
    const colour = state.pen?.colour ?? STROKE;
    paintInk(ctx, points, { colour: STROKE_HALO, scale: 1.9, width: state.pen?.width });
    paintInk(ctx, points, { colour, width: state.pen?.width });
    return;
  }

  const [a, b] = points;
  if (!a || !b) return;

  if (state.tool === "region") {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
    return;
  }

  drawArrow(ctx, a, b, lineWidth);
}

export function AnnotationCanvas({
  stageRect: stageRectProp,
  tool,
  frameMarks,
  pen,
  board,
  onStroke,
  onErase,
}: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<EditorState>(() => idle(tool));

  /**
   * Mirror of `state` for pointer handlers.
   *
   * Needed because a React state updater must stay pure: finishing a stroke has to
   * report it, and doing that inside the updater fires twice under StrictMode's
   * double invocation, producing two identical marks.
   *
   * Pointer handlers **read** from this ref rather than `state` so two events in the
   * same frame cannot see a stale value and drop the last segment of the stroke. It is
   * written only through `commitState` — never during render — because a render that
   * is already scheduled could otherwise restore an older value over a newer one.
   */
  const stateRef = useRef<EditorState>(state);

  /*
   * The board occupies **the video's place**, not the whole window.
   *
   * The requirement is that the page is the same size as the picture: swapping the two
   * must not move anything around, and a stroke drawn in one place must land in the same
   * place after a swap. Using the same rect is what makes that true, and it reuses every
   * existing rule (normalization, clamping, eraser tolerance) unchanged — switching modes
   * is a change of *what is painted*, not of geometry.
   *
   * When the stage has not been measured yet there is nothing to align to, so the board
   * falls back to the viewport rather than collapsing to zero.
   */
  const stageRect = useMemo(() => {
    if (!board) return stageRectProp;
    if (stageRectProp && stageRectProp.width > 0 && stageRectProp.height > 0) return stageRectProp;
    return {
      left: 0,
      top: 0,
      width: typeof window === "undefined" ? 0 : window.innerWidth,
      height: typeof window === "undefined" ? 0 : window.innerHeight,
    };
  }, [board, stageRectProp]);

  /** Advance the machine: the ref first (so handlers see it immediately), React second. */
  const commitState = useCallback((next: EditorState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Switching tools abandons any gesture in progress.
  useEffect(() => {
    commitState(stateRef.current.status === "idle" ? idle(tool) : cancel(stateRef.current));
  }, [tool, commitState]);

  const toNormalizedPoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      if (!stageRect || stageRect.width <= 0 || stageRect.height <= 0) return null;
      const x = (clientX - stageRect.left) / stageRect.width;
      const y = (clientY - stageRect.top) / stageRect.height;
      // Allow slight overshoot then clamp, so shaking at the edge does not break the stroke.
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    },
    [stageRect],
  );

  /**
   * A pointer position plus its pressure, for handwriting.
   *
   * ## Why pressure is read from the pointer and not from a guess
   *
   * `PointerEvent.pressure` is what a digitizer reports: a pen gives 0..1 as you press
   * harder, a mouse gives a flat 0.5, and a device without the sensor may omit it. Only
   * the first case is a measurement. Inventing pressure for the others would produce a
   * uniformly medium-thick line — indistinguishable from the feature being broken.
   *
   * The `pointerType` check is the only reliable way to tell them apart: pressure 0.5
   * is a legitimate light pen press, so the value alone cannot decide.
   */
  const toInkPoint = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): InkPoint | null => {
      const base = toNormalizedPoint(event.clientX, event.clientY);
      if (!base) return null;
      if (event.pointerType !== "pen") return base;
      return { ...base, pressure: event.pressure };
    },
    [toNormalizedPoint],
  );

  /**
   * One coalesced sample, converted the same way as the live event.
   *
   * Kept as a plain function rather than a hook callback because it needs the stage
   * rect from the closure and is only ever called from inside a pointer handler.
   */
  const toInkPointFromSample = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, sample: PointerEvent): InkPoint | null => {
      const base = toNormalizedPoint(sample.clientX, sample.clientY);
      if (!base) return null;
      if (event.pointerType !== "pen") return base;
      return { ...base, pressure: sample.pressure };
    },
    [toNormalizedPoint],
  );

  /** Normalized eraser radius for this stage, so it feels the same at any zoom. */
  const eraserTolerance = useMemo(() => {
    if (!stageRect || stageRect.width <= 0 || stageRect.height <= 0) return 0.01;
    return ERASER_RADIUS_PX / Math.min(stageRect.width, stageRect.height);
  }, [stageRect]);

  // ── Painting ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale by device pixel ratio so lines are not blurry on HiDPI screens.
    const dpr = window.devicePixelRatio || 1;
    const width = stageRect?.width ?? 0;
    const height = stageRect?.height ?? 0;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (width === 0 || height === 0) return;

    const px = (point: Point): Point => ({ x: point.x * width, y: point.y * height });
    const toPixels = (point: InkPoint): InkPoint => ({
      x: point.x * width,
      y: point.y * height,
      ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
    });
    const lineWidth = 2.5;

    /*
     * Board mode paints the page first, then the page's own marks — and **no badges**.
     *
     * Everything below this branch is about annotating a frame: numbered targets, and the
     * prompt that names them. A page has neither, so the marks are painted through the
     * same shape painter with `badge: null`. The video marks are not present in `board`
     * at all, which is what keeps the two surfaces from bleeding into each other.
     */
    if (board) {
      ctx.fillStyle = board.background;
      ctx.fillRect(0, 0, width, height);

      /*
       * Every tool works on paper, and **none of it is numbered**.
       *
       * A page is not a frame to annotate: nothing in the prompt refers to a shape drawn
       * here, so an ordinal would be an identifier for something nobody can name. The
       * shapes are still drawn — a box around a paragraph or an arrow pointing where a
       * block should go is exactly what a sketch is for — they simply carry no badge.
       */
      for (const mark of board.marks) {
        paintShape(ctx, mark.stroke, px, toPixels, lineWidth, null);
      }

      paintGesture(ctx, state, toPixels, lineWidth);
      return;
    }

    /*
     * One painter for both surfaces, and one numbering rule (see `numberedMarks`).
     *
     * Withdrawn marks are skipped for painting but still consume their number, so every
     * later badge keeps its ordinal — and the prompt's red block keeps naming the same one.
     */
    for (const mark of frameMarks) {
      paintShape(ctx, mark.shape, px, toPixels, lineWidth, mark.badge);
    }

    paintGesture(ctx, state, toPixels, lineWidth);
  }, [frameMarks, state, stageRect, board]);

  // ── Pointer interaction ─────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const point = toInkPoint(event);
      if (!point) return;

      if (tool === "eraser") {
        // The eraser's second depth (press-and-hold to clear everything) lives on the
        // toolbar button, not here: that is the control the user holds.
        releaseFieldFocus();
        onErase(point, eraserTolerance);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      if (tool === "select") return;

      /*
       * Pressing the picture **takes the focus off any text field**.
       *
       * `preventDefault` below stops the browser from moving focus, which is what keeps
       * the caret where it was — and that is wrong here: after drawing, the user is drawing,
       * not writing. Leaving the caret in the prompt box meant `Ctrl+Z` still addressed the
       * text and the box kept looking "active" while the pointer was on the canvas
       * (found.md F-102).
       *
       * The canvas itself is not focusable on purpose: it must not show a focus ring, and
       * nothing needs to be focused for a pointer-driven layer to work.
       */
      releaseFieldFocus();

      event.currentTarget.setPointerCapture(event.pointerId);
      /*
       * The pen is captured at the moment the stroke starts.
       *
       * Reading it at the end would let a colour change mid-stroke repaint the whole
       * line, and reading it from a ref here would let a later change reach a stroke
       * that was already drawn. Both are surprising; "the pen you pressed down with" is
       * the only meaning the user expects.
       */
      commitState(beginStroke(idle(tool), point, pen));
      event.preventDefault();
    },
    [toInkPoint, tool, commitState, onErase, eraserTolerance],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = toInkPoint(event);
      if (!point) return;
      const current = stateRef.current;
      if (current.status !== "drawing") return;
      /*
       * `getCoalescedEvents` returns every sample the digitizer produced since the last
       * frame. Without it a 240Hz pen on a 60Hz screen loses three samples in four, and
       * fast handwriting comes out as a polygon with visible flat sides — the stroke is
       * drawn from points the browser happened to deliver, not from where the pen went.
       */
      const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
      let next = current;
      for (const sample of coalesced) {
        const extra = toInkPointFromSample(event, sample);
        if (extra) next = extendStroke(next, extra);
      }
      next = extendStroke(next, point);
      commitState(next);
    },
    [toInkPoint, commitState],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const current = stateRef.current;
      if (current.status !== "drawing") return;

      const shape = finishStroke(current);
      commitState(idle(current.tool));
      // A click or a twitch produces nothing; a real gesture becomes a mark.
      if (shape) onStroke(shape);
    },
    [onStroke, commitState],
  );

  /*
   * Each tool has its own pointer, because the cursor is the only feedback before the
   * first stroke: it says what the next press will start. One crosshair for a pen, an arrow
   * and a box threw that away (see `cursors.ts`).
   */
  const cursor = useMemo(() => cursorForTool(tool), [tool]);

  return (
    <canvas
      ref={canvasRef}
      data-mystudio-overlay="annotation-canvas"
      style={{
        /*
         * `fixed`, not `absolute`.
         *
         * `stageRect` comes from `getBoundingClientRect()`, which is in **viewport**
         * coordinates. With `absolute` the canvas is positioned against its scrolling
         * ancestor, so as soon as the layout scrolls the drawing layer drifts away
         * from the picture and clicks land at the wrong normalized point.
         */
        position: "fixed",
        left: stageRect?.left ?? 0,
        top: stageRect?.top ?? 0,
        pointerEvents: tool === "select" ? "none" : "auto",
        cursor,
        // Above Studio's splitter and above the shield (see layers.ts).
        zIndex: ANNOTATION_LAYERS.canvas,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={(event) => event.preventDefault()}
      // Keep the browser from turning a drag into a text/element selection.
      onDragStart={(event) => event.preventDefault()}
      aria-label="Annotation canvas"
    />
  );
}
