/**
 * The annotation assembly layer: wires drawing, state, frame capture and delivery
 * together.
 *
 * All side effects live in this one hook so the UI components stay presentational:
 * swapping the skin never touches business logic, and changing how prompts are
 * delivered never touches the UI.
 *
 * ## The interaction, in order
 *
 * 1. drag with a drawing tool → the stroke stays on the frame immediately;
 * 2. press `S` → its block reference is appended to the prompt, on its own line;
 * 3. `Ctrl+Z` → the newest stroke is undone; if it was already in the prompt its
 *    block turns red instead of vanishing (see `annotationStore.undoLast`);
 * 4. eraser → click to erase one mark; press and hold the eraser button to clear
 *    every mark at every timecode.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Annotation,
  AnnotationBundle,
  AnnotationShape,
  DeliveryOutcome,
  ElementRef,
  FrameRef,
  HostConfig,
  InkCapture,
  SaveFrameResponse,
  ElementTarget,
} from "@mystudio/protocol";
import {
  BRIDGE_ROUTES,
  isReferenceAnnotation,
  isReferenceableShape,
  renderBundleWithElements,
  renderUserPrompt,
} from "@mystudio/protocol";
import { labelForTarget, type BlockTarget } from "./promptSchema.js";
import { annotationOrdinals, withTarget, withoutTarget, type RequestEntry } from "./requestOrder.js";
import { selectCanRedo, selectCanUndo, useAnnotationStore } from "./annotationStore.js";
import type { AnnotationTool } from "./editorState.js";
import { captureFrame } from "./frameCapture.js";
import { describeElement, pickElementAt } from "./geometry.js";
import { snapshotFrame } from "./frameContext.js";
import { composeInk, inkScaleForFrame } from "./composeInk.js";
import { boardSignature, composeBoardPicture } from "./boardPicture.js";
import type { BoardMark } from "./boardStore.js";
import { liveStrokesOn, needsCapture, snapshotSignature } from "./snapshotSignature.js";
import { frameMarks as frameMarksFor, type FrameMark, type FrameSelector } from "./frameMarks.js";
import { type SelectionLike, toElementTarget } from "./elementCapture.js";
import { decideNextAction } from "./nextAction.js";
import { captureKey, elementKey, hasElement } from "./targetKey.js";
import type { BoundElement } from "@mystudio/protocol";

/** Re-exported because the hook's callers name the same element block. */
export type { BoundElement } from "@mystudio/protocol";

export interface PreviewStageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface UseAnnotationsOptions {
  readonly config: HostConfig | null;
  readonly stageRect: PreviewStageRect | null;
  /** Current playhead time, from Studio's context. */
  readonly currentTime: number;
  readonly activeCompPath: string | null;
  readonly compositionWidth: number | null;
  readonly compositionHeight: number | null;
  readonly previewIframe: HTMLIFrameElement | null;
  /**
   * Whether the annotation window is active, i.e. whether this layer owns the keyboard.
   *
   * Passed in rather than read from a store so the hook has one input for "am I in
   * charge right now"; undo/redo must not fire while Studio is being used normally.
   */
  readonly annotating: boolean;
  /**
   * The whiteboard page showing right now, or `null` when the video is showing.
   *
   * ## Why it is passed in and not read from `useBoardStore` here
   *
   * The board store exists so board ink and video annotations **cannot** touch each other
   * (found.md F-061), and this hook is where a delivery is assembled. Reaching into the board
   * store from inside it would make the two stores meet in the one place that decides what
   * gets sent — which is fine — but it would also make this hook impossible to drive from a
   * test, and it would hide the seam.
   *
   * Passing it in keeps that seam explicit: the caller says "this is the page on screen", and
   * the hook decides what a page means for the request.
   */
  readonly board: {
    /** Opaque identity of the page on screen, so "unchanged" is answered per page. */
    readonly key: string;
    /** The page's marks, already filtered to the current page by the caller. */
    readonly marks: readonly BoardMark[];
    /** Page colour, so the delivered picture has the same paper as the screen. */
    readonly background: string;
  } | null;
}

export function useAnnotations(options: UseAnnotationsOptions) {
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [delivering, setDelivering] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<DeliveryOutcome | null>(null);
  /** Why the frame capture failed; null when everything is fine. */
  const [frameWarning, setFrameWarning] = useState<string | null>(null);
  /**
   * What the user has written in the box, as plain text.
   *
   * A **copy**, published by the editor on every change. It exists because delivery needs a
   * string and the editor owns a document; it is never written back into the editor, so the
   * two cannot fight over it (found.md F-118).
   */
  const [promptText, setPromptText] = useState("");
  /**
   * The request: every block the user has asked for, **in the order they asked**.
   *
   * This is the single source of every block number. The box renders chips from it, the canvas
   * takes its badges from it, and delivery takes its order from it — one array, so the picture
   * and the text cannot disagree about what `Arrow 2` means (found.md F-107, F-118).
   *
   * Nothing else stores a number: not the annotation, not the element, not the capture.
   */
  const [order, setOrder] = useState<readonly RequestEntry[]>([]);
  /**
   * `order` mirrored in a ref.
   *
   * The picture capture runs inside a callback that must not be rebuilt on every reorder, but
   * it needs the request's current order to number the marks. A ref is the one reading that is
   * both current and cheap (found.md F-122).
   */
  const orderRef = useRef(order);
  orderRef.current = order;
  /**
   * Elements added to the prompt from Studio's own selection.
   *
   * Kept beside the annotations rather than inside them: an element is not a mark on the
   * frame — it has no timecode, no picture and no geometry in the annotation sense — but
   * it is a **target** the user's sentence can name, so it gets a block and travels in
   * the same request.
   */
  const [elementTargets, setElementTargets] = useState<readonly BoundElement[]>([]);
  /**
   * Composed pictures of frames that carry handwriting, one per frame.
   *
   * Ink is delivered as an image rather than as a block, so these are kept beside the
   * annotations instead of inside one: a picture belongs to a frame, and several strokes
   * on the same frame are one picture.
   */
  /**
   * The composed picture of each frame, keyed by frame: "what this frame looks like now".
   *
   * Separate from `captures` below because they answer different questions. This one is the
   * **current** image a capture would attach; `captures` is the list of captures the user has
   * actually added to the request. One drawing action can change the former without touching
   * the latter, which is exactly what "draw, look, then add it" needs.
   */
  const [inkImages, setInkImages] = useState<readonly InkCapture[]>([]);
  /**
   * Captures the user has added to the prompt, each with its own `Capture N` block.
   *
   * They point at the frame's current picture, so several entries may reference the same
   * image; adding a second capture after drawing again is what makes the request show the
   * progression rather than only the last state.
   */
  const [captures, setCaptures] = useState<readonly InkCapture[]>([]);
  /**
   * The state each stored picture was captured from.
   *
   * Keyed by frame; compared before regenerating. Two presses of add-to-prompt with nothing
   * drawn in between must not produce a second, identical picture (see
   * `snapshotSignature.ts`).
   */
  const capturedSignatures = useRef<Map<string, string>>(new Map());

  const annotations = useAnnotationStore((s) => s.annotations);
  const addAnnotation = useAnnotationStore((s) => s.add);
  const setFrameImagePath = useAnnotationStore((s) => s.setFrameImagePath);
  const boundIds = useAnnotationStore((s) => s.boundIds);
  const removeAnnotation = useAnnotationStore((s) => s.remove);
  const undoShapes = useAnnotationStore((s) => s.undo);
  const redoShapes = useAnnotationStore((s) => s.redo);
  const canUndo = useAnnotationStore(selectCanUndo);
  const canRedo = useAnnotationStore(selectCanRedo);
  const eraseAt = useAnnotationStore((s) => s.eraseAt);
  const clearAll = useAnnotationStore((s) => s.clear);

  // Latest geometry lives in a ref so callbacks do not have to be rebuilt on every time change.
  const geomRef = useRef(options);
  geomRef.current = options;

  /**
   * The board page on screen, mirrored in a ref.
   *
   * `addBoardBlock` runs inside a long-lived callback that must not be rebuilt on every stroke,
   * and it needs the page **as it is right now** — a state value read from the closure would
   * answer from the last render, which is one stroke behind (the same reasoning as `orderRef`).
   */
  const boardRef = useRef(options.board);
  boardRef.current = options.board;

  /**
   * The frame the user is looking at, mirrored in a ref.
   *
   * A board sketch still records which frame the board replaced — not to describe it (a
   * sketch has no timecode), but so the routing that identifies a capture keeps working and
   * a `Drawing N` can be recognised as belonging to this session rather than to nothing.
   */
  const activeFrameRef = useRef<FrameSelector>({ compositionPath: "index.html", time: 0 });

  /**
   * `elementTargets` mirrored in a ref.
   *
   * The duplicate check must be answerable **right now**, before any state update runs: a
   * functional updater cannot report "already there" back to the caller, and reading
   * `elementTargets` from the closure would answer from the last render.
   */
  const elementTargetsRef = useRef(elementTargets);
  elementTargetsRef.current = elementTargets;

  /**
   * The state each **added capture** was made from, keyed by frame.
   *
   * Distinct from `capturedSignatures` (which tracks the frame's current picture): this one
   * answers "would a new capture be identical to the last one the user added", which is the
   * duplicate rule for capture blocks.
   */
  const lastCaptureSignatureRef = useRef<Map<string, string>>(new Map());

  /**
   * The state each board page's last `Drawing N` block was made from, keyed by page.
   *
   * Same job as `lastCaptureSignatureRef` on the other surface, and kept separate for the same
   * reason the stores are separate: a signature describes one surface's picture, and mixing
   * them would let a stroke on the video suppress a drawing on the page.
   */
  const boardSignatureRef = useRef<Map<string, string>>(new Map());

  /** `captures` mirrored in a ref, for the same synchronous-read reason. */
  const capturesRef = useRef(captures);
  capturesRef.current = captures;

  /** Stable key for a frame, used to remember which state each picture came from. */
function frameKey(frame: FrameRef): string {
  return `${frame.compositionPath}@${frame.time.toFixed(3)}`;
}

/** Write the captured frame to disk and attach it to the annotation. */
  /**
   * The picture of the current moment, at the **composition's own resolution**.
   *
   * ## Why not a screen grab
   *
   * The screen is the composition **scaled down** to fit the window. Capturing it produced a
   * 450×253 image where the project is 1920×1080, and "a smaller picture" is not the same
   * thing as "what the user sees": the marks are vectors, so they can be re-drawn at full
   * resolution and stay sharp, while a screenshot cannot be scaled back up without losing the
   * detail the reader needs (found.md F-114).
   *
   * So: a **clean frame at native density** from the renderer, then the marks re-drawn on it
   * at the same resolution. Both halves are full size, and the result is the frame the user is
   * looking at — not a photograph of a window.
   */
  const capturePictureArea = useCallback(async (): Promise<string | null> => {
    const {
      currentTime,
      activeCompPath,
      compositionWidth,
      compositionHeight,
      previewIframe,
      config,
    } = geomRef.current;
    if (!config) return null;

    const snapshot = snapshotFrame({
      currentTime,
      iframe: previewIframe,
      overrides: { activeCompPath, compositionWidth, compositionHeight },
    });
    const captured = await captureFrame(snapshot.frame, { projectId: config.projectId });
    if (!captured.ok) {
      setFrameWarning(`The frame capture could not be saved (${captured.message})`);
      return null;
    }

    /*
     * The marks to paint, **from the same function the canvas uses**.
     *
     * This used to be its own loop with its own counter, which is how the delivered picture
     * came to show a numbered mark the screen did not have: two computations of "which marks
     * are on this frame, numbered how" (found.md F-122).
     *
     * `strokeScale` converts screen-pixel widths into composition pixels; without it the ink
     * was 3px wide on a 1920px image — present, but invisible (found.md F-112).
     */
    const state = useAnnotationStore.getState();
    const marks = frameMarksFor(
      state.annotations,
      { compositionPath: snapshot.frame.compositionPath, time: snapshot.frame.time },
      /*
       * The live request order, through the same function the canvas uses.
       *
       * `orderRef` rather than the `order` state because this runs inside a callback that must
       * not be rebuilt on every reorder — and reading the ref keeps the two readings identical
       * (found.md F-122).
       */
      annotationOrdinals(orderRef.current),
    );

    const stage = geomRef.current.stageRect;
    const scale = inkScaleForFrame(
      stage?.width ?? snapshot.frame.compositionWidth,
      snapshot.frame.compositionWidth,
    );
    const composed = await composeInk({
      framePngBase64: captured.pngBase64,
      shapes: marks.map((mark) => mark.shape),
      badges: marks.map((mark) => mark.badge),
      strokeScale: scale,
    });
    if (!composed.ok) {
      setFrameWarning(`The annotated frame could not be composed (${composed.message})`);
      return null;
    }
    setFrameWarning(null);
    return composed.pngBase64;
  }, []);

  /**
   * Compose the current **board page** into a picture.
   *
   * Same gesture as `capturePictureArea`, different paper: there is no frame to fetch, because
   * a board page is not a moment of the video. So the page is drawn from its own marks with the
   * same painter the live canvas uses, at the composition's design size — the same size the
   * video's picture has, which is the rule that makes the two surfaces interchangeable.
   *
   * The page comes from the board option rather than from `useBoardStore` directly: this hook
   * is the composition point, and reaching into another store from here would be the second
   * place that decides what a page is.
   */
  const composeBoardPictureArea = useCallback(async (): Promise<string | null> => {
    const board = boardRef.current;
    if (!board) return null;

    const { compositionWidth, compositionHeight, stageRect } = geomRef.current;
    const width = compositionWidth ?? 1920;
    const height = compositionHeight ?? 1080;
    const scale = inkScaleForFrame(stageRect?.width ?? width, width);

    const drawn = await composeBoardPicture({
      width,
      height,
      background: board.background,
      shapes: board.marks.map((mark) => mark.stroke),
      strokeScale: scale,
    });
    if (!drawn.ok) {
      setFrameWarning(`The board could not be composed (${drawn.message})`);
      return null;
    }
    setFrameWarning(null);
    return drawn.pngBase64;
  }, []);

  /**
   * Take the picture of the **current frame** and attach it to one block.
   *
   * This is the `Ctrl+S` gesture for a numbered mark: the user asks for the block, and the
   * picture is composed at that moment. Nothing is captured while drawing, so there is no
   * file to go stale and no work spent on frames the user never sends
   * (the user's words: "我按 Ctrl S 的时候再截那一帧").
   */
  const attachPicture = useCallback(
    async (annotationId: string) => {
      const {
        currentTime,
        activeCompPath,
        compositionWidth,
        compositionHeight,
        previewIframe,
        config,
      } = geomRef.current;
      if (!config) return;

      const snapshot = snapshotFrame({
        currentTime,
        iframe: previewIframe,
        overrides: { activeCompPath, compositionWidth, compositionHeight },
      });
      void snapshot;
      const pngBase64 = await capturePictureArea();
      if (!pngBase64) return;
      const saved = await saveFrame(annotationId, pngBase64);
      if (!saved.ok) {
        setFrameWarning(`The picture was captured but saving it failed (${saved.error})`);
        return;
      }
      setFrameImagePath(annotationId, saved.path);
    },
    [capturePictureArea, setFrameImagePath],
  );

  /**
   * Capture this frame, **unless it already has a picture of exactly this state**.
   *
   * Two presses of add-to-prompt with nothing drawn in between must produce one picture, not
   * two identical ones (the user's rule: "连按两次 Ctrl+S 只有一个截图"). Drawing again, or
   * selecting a *different* element, changes the signature and produces a new one.
   *
   * The capture is always taken from the clean frame and recomposed, never by screenshotting
   * the page: the delivered image must not contain the toolbar, the prompt box or whatever
   * zoom the window happens to have.
   */
  /**
   * Add the current frame as a `Capture N` block.
   *
   * Used when the newest action was a stroke: ink has no reference, so the picture of the
   * moment **is** the block. Guarded by the state signature so pressing add-to-prompt twice
   * with nothing drawn in between does not create an identical second entry.
   */
  const addCaptureBlock = useCallback(async () => {
    const {
      currentTime,
      activeCompPath,
      compositionWidth,
      compositionHeight,
      previewIframe,
      config,
    } = geomRef.current;
    if (!config) return;

    const snapshot = snapshotFrame({
      currentTime,
      iframe: previewIframe,
      overrides: { activeCompPath, compositionWidth, compositionHeight },
    });
    const state = useAnnotationStore.getState();

    /*
     * The signature must include everything a reader would see differently: the strokes on
     * this frame **and** which element the request names.
     */
    const signature = snapshotSignature({
      compositionPath: snapshot.frame.compositionPath,
      time: snapshot.frame.time,
      strokes: liveStrokesOn(
        state.annotations,
        snapshot.frame.compositionPath,
        snapshot.frame.time,
      ),
    });

    /*
     * The gate is about **state**, not about the press.
     *
     * The user's rule: "连按两次 Ctrl+S 只有一个截图；我再画一条线，会有新的截图". So a capture is
     * produced when the visible state has moved since the last one the user added — pressing
     * again with nothing changed must not produce an identical second block
     * (found.md F-106).
     */
    /*
     * A capture is the block for **handwriting**, and for nothing else.
     *
     * Ink has no reference to name, so the picture *is* its content. A region, an arrow or an
     * element already owns a reference and carries its own picture, so a capture beside it would
     * deliver the same image twice — which is what produced `Element 1` + `Capture 2` for one
     * action (found.md F-122).
     */
    if (!needsCapture(state.annotations, snapshot.frame)) return;

    const last = lastCaptureSignatureRef.current.get(frameKey(snapshot.frame));
    if (last === signature) return;

    const captured = await captureFrame(snapshot.frame, { projectId: config.projectId });
    if (!captured.ok) {
      setFrameWarning(`The frame capture could not be saved (${captured.message})`);
      return;
    }
    setFrameWarning(null);
    capturedSignatures.current.set(frameKey(snapshot.frame), signature);

    /*
     * A capture is a **block the user can name and delete**, exactly like `Element 1`.
     *
     * Appending its reference to the prompt text is what makes that true: the chip is the
     * only place the user can see a picture will be sent, and the only place to remove it
     * before sending. A badge that could not be deleted was the first attempt, and the
     * user's answer was blunt: "我怎么把它删掉？你像 Elements 1 这些一样不就得了？"
     * (found.md F-106).
     */


    /*
     * One block per **action**, pointing at this frame's current picture.
     *
     * `Capture 3` names the picture the user was looking at when they asked for it; a later
     * drawing refreshes that picture and can be added again as `Capture 4`. The images on
     * disk are separate files, so an earlier capture keeps its own content even though the
     * frame's "current" image moves on.
     */
    /*
     * One composed picture per capture, written under its own name.
     *
     * The picture is composed **now**, not re-read from a cache: it must show exactly the
     * marks that were on screen when the user asked for it. Each capture keeps its own file so
     * a later drawing cannot rewrite the image this reference points at.
     */
    const picture = await capturePictureArea();
    if (!picture) return;
    const own = await saveFrame(
      `${frameKey(snapshot.frame).replace(/[^A-Za-z0-9]/g, "_")}_${Date.now().toString(36)}`,
      picture,
    );
    if (!own.ok) {
      setFrameWarning(`The capture could not be saved (${own.error})`);
      return;
    }
    lastCaptureSignatureRef.current.set(frameKey(snapshot.frame), signature);
    /*
     * Adding the capture **is** adding the block. There is no second step that appends its
     * reference to a string: the box reads its blocks from this list, so the chip appears
     * because the capture exists (found.md F-118).
     */
    setCaptures((current) => [
      ...current,
      { compositionPath: snapshot.frame.compositionPath, time: snapshot.frame.time, imagePath: own.path },
    ]);
    setOrder((current) => withTarget(current, { kind: "capture", id: own.path }));
  }, [capturePictureArea]);

  /**
   * Add the current **board page** as a `Drawing N` block.
   *
   * ## The same gesture as a capture, on different paper
   *
   * Pressing `Ctrl+S` while the board is showing must do what it does on the video: take the
   * picture of what is on screen right now and add it as one block the user can see and
   * delete. Before this existed, board ink lived only in `boardStore`, which the request never
   * reads — so the key did nothing at all and there was no chip (found.md F-128).
   *
   * ## What is deliberately the same, and what is deliberately different
   *
   * Same: the duplicate rule (pressing twice with nothing drawn adds one block), the picture
   * being composed at the moment of the press, one file per block, and the block joining the
   * one shared request order.
   *
   * Different: the name (`Drawing N`, because there is no frame behind it), and there is **no
   * badge** on the paper — a page has nothing for a number to refer to.
   */
  const addBoardBlock = useCallback(async () => {
    const board = boardRef.current;
    const config = geomRef.current.config;
    if (!board || !config) return;

    /*
     * The duplicate rule, per page.
     *
     * Signing the page rather than the frame is what makes "nothing changed" mean the right
     * thing: turning to a different page is a different picture even when it happens to carry
     * the same number of strokes.
     */
    const signature = `${board.key}#${boardSignature(board.marks.map((mark) => mark.stroke))}`;
    const previous = boardSignatureRef.current.get(board.key);
    if (previous === signature) return;

    const picture = await composeBoardPictureArea();
    if (!picture) return;

    const saved = await saveFrame(`board_${Date.now().toString(36)}`, picture);
    if (!saved.ok) {
      setFrameWarning(`The drawing could not be saved (${saved.error})`);
      return;
    }

    boardSignatureRef.current.set(board.key, signature);

    /*
     * One block per press, in the shared order.
     *
     * `board: true` is what tells delivery this picture has no frame behind it, so the prompt
     * describes a sketch instead of printing a composition path and a timecode that would
     * point at footage nobody drew on (found.md F-128).
     */
    const frame = activeFrameRef.current;
    setCaptures((current) => [
      ...current,
      {
        compositionPath: frame.compositionPath,
        time: frame.time,
        imagePath: saved.path,
        board: true,
      },
    ]);
    setOrder((current) => withTarget(current, { kind: "drawing", id: saved.path }));
  }, [composeBoardPictureArea]);

  /**
   * Append an annotation to the prompt, on a line of its own, and bind it.
   *
   * This is `S`. Append rather than replace, because the user writes as they draw:
   * circle one thing, press S, write a sentence, circle the next, press S again.
   *
   * `id` defaults to the newest mark, which is what the shortcut means. The toolbar
   * passes an explicit id when the user adds an older mark by hand.
   *
   * Ink is skipped on purpose: it has no block reference to append (see
   * `isReferenceableShape`), and it is delivered as the picture of the frame instead.
   * Pressing `S` after handwriting therefore names the newest **numbered** mark, which is
   * what a user scribbling and then circling something means.
   */
  /**
   * A stroke finished: record it on the frame. **No picture is taken here.**
   *
   * The user's rule: "我说的发送时再解释，我按 Ctrl S 的时候再截那一帧." A picture belongs to
   * the moment a block joins the request, not to the moment something was drawn — so drawing
   * costs nothing and no file goes stale (found.md F-113).
   */
  const handleStroke = useCallback(
    async (shape: AnnotationShape) => {
      const { currentTime, activeCompPath, compositionWidth, compositionHeight, previewIframe } =
        geomRef.current;

      const snapshot = snapshotFrame({
        currentTime,
        iframe: previewIframe,
        overrides: { activeCompPath, compositionWidth, compositionHeight },
      });

      // The element at the arrow's tail is "the thing to move"; the head is only a target.
      let element: ElementRef | undefined;
      if (shape.kind === "arrow" && snapshot.doc) {
        const hit = pickElementAt(snapshot.doc, shape.from);
        if (hit) element = describeElementInViewport(hit, snapshot.doc);
      }

      // The mark exists immediately: drawing is the action, not a proposal.
      addAnnotation({ shape, frame: snapshot.frame, ...(element ? { element } : {}) });
    },
    [addAnnotation],
  );

  /**
   * Add one element as a block. **Internal**: `addToPrompt` is the only entry point.
   *
   * Keeping this separate from the public path is deliberate — it is the *action* for one kind,
   * not a second place that decides anything. It used to be public and used to call
   * `addCaptureBlock` at the end, which is how one press produced two blocks
   * (found.md F-122).
   *
   * The same element twice is a no-op: the user means "this one", and two blocks pointing at the
   * same node would claim two changes.
   */
  const addElementBlock = useCallback(
    (target: ElementTarget) => {
      /*
       * Duplicate check comes **first**, and it decides both halves.
       *
       * The same element added twice is "this one", not two blocks — so the second press must
       * do nothing at all. The old order appended the reference to the prompt text *before*
       * checking, so every press added another `Element 1` line while the block list stayed
       * at one: the text grew duplicates that named the same target (found.md F-103).
       */
      if (hasElement(elementTargetsRef.current, target)) return;

      /*
       * The block is the entry in this list — nothing else names it. Its label and number are
       * derived from its position when the box renders, so no reference is computed or written
       * here (found.md F-118).
       *
       * The frame is recorded **with** the block, not only with its picture. A picture of a frame
       * that the request never names is evidence nobody can reproduce, and in a request that
       * touches two compositions it is misleading: the reader would look for the element at some
       * unrelated mark's timecode (found.md F-129).
       */
      const here = snapshotFrame({
        currentTime: geomRef.current.currentTime,
        iframe: geomRef.current.previewIframe,
        overrides: {
          activeCompPath: geomRef.current.activeCompPath,
          compositionWidth: geomRef.current.compositionWidth,
          compositionHeight: geomRef.current.compositionHeight,
        },
      }).frame;
      setElementTargets((entries) => [...entries, { target, frame: here }]);
      setOrder((current) => withTarget(current, { kind: "element", id: elementKey(target) }));

      /*
       * Capture the frame **after** the block exists, so a slow render never delays the
       * chip appearing. This is what turns "Element 1" into something a reader can look at:
       * the selector says how to find it in the code, the picture says what the user saw.
       *
       * A failed capture is reported, not silent: an element block without its picture is
       * still valid, but the user should know the evidence is missing.
       */
      void (async () => {
        const { currentTime, activeCompPath, compositionWidth, compositionHeight, previewIframe, config } =
          geomRef.current;
        if (!config) return;
        const snapshot = snapshotFrame({
          currentTime,
          iframe: previewIframe,
          overrides: { activeCompPath, compositionWidth, compositionHeight },
        });
        void snapshot;
        /*
         * The element's picture is the screen too: selecting an element adds a description, it
         * does not replace what the user was looking at. Two blocks from the same moment must
         * never show two different pictures (found.md F-113).
         */
        const picture = await capturePictureArea();
        if (!picture) return;
        const saved = await saveFrame(`element_${hashFrameKey(snapshot.frame)}`, picture);
        if (!saved.ok) {
          setFrameWarning(`The frame was captured but saving it failed (${saved.error})`);
          return;
        }
        setElementTargets((current) =>
          current.map((entry) =>
            elementKey(entry.target) === elementKey(target)
              ? { ...entry, frameImagePath: saved.path }
              : entry,
          ),
        );
        /*
         * No `Capture` block is added here.
         *
         * Selecting an element adds `Element N`, and that block **already carries this very
         * picture** — `frameImagePath` above is the same frame at the same moment. Adding a
         * `Capture N` beside it sent the same image twice and made the request read as though
         * the user had asked for two things (found.md F-122).
         *
         * A capture is only ever the block for **handwriting**, where there is no reference to
         * name and the picture is the whole content.
         */
      })();
    },
    [capturePictureArea],
  );

  /**
   * `Ctrl+S`: **one press, one block**.
   *
   * What the block is comes from the **last action**, decided once in `nextAction.ts`. That
   * module exists because the decision used to be spread over three places — this callback, the
   * shortcut handler, and `addElementToPrompt` — and one press could reach two of them, which is
   * how a selected element produced `Element 1` **and** `Capture 2`, the same picture twice
   * (found.md F-122).
   *
   * So there is exactly one branch per kind here, and each branch adds exactly one block:
   *
   * | last action | block | picture |
   * |---|---|---|
   * | element selected | `Element N` | the block's own `frameImagePath` |
   * | region / arrow | `Region N` / `Arrow N` | the block's own `frameImagePath` |
   * | handwriting | `Capture N` | the block **is** the picture |
   *
   * @param selected Studio's current element selection, if any. Passed in rather than read from
   * a ref so the caller states what "just now" means at the moment of the press.
   */
  const addToPrompt = useCallback(
    (selected: ElementTarget | null = null) => {
      /*
       * The board is not a frame, so it does not go through `decideNextAction`.
       *
       * That function decides between an element, a numbered mark and ink **on the video**.
       * None of the three exists on a page: there is no Studio DOM to pick an element from, a
       * page's shapes are never numbered, and its ink is not `annotations`. Asking it anyway
       * would answer "capture", and the capture path fetches a video frame — which is the bug
       * this branch removes (found.md F-128).
       *
       * So while the board is showing there is exactly one action: add the page as a
       * `Drawing N`. The element selection is ignored on purpose rather than merely unchecked —
       * a cycle's tail can still be selected in Studio underneath, and honouring it would make
       * one press add two different things.
       */
      if (boardRef.current) {
        void addBoardBlock();
        return;
      }

      const action = decideNextAction({
        selected,
        selectedAlreadyAdded: selected !== null && hasElement(elementTargetsRef.current, selected),
        annotations,
        bound: boundIds,
      });

      switch (action.kind) {
        case "element":
          addElementBlock(action.target);
          return;

        case "mark": {
          const mark = action.annotation;
          /*
           * Binding **is** adding the block. The number is the block's position in the
           * request, read when the box renders; storing one would mean rewriting it on every
           * deletion, which is what used to break the caret (found.md F-118).
           */
          useAnnotationStore.getState().bind(mark.id);
          setOrder((current) =>
            withTarget(current, { kind: "annotation", id: mark.id, shape: mark.shape.kind }),
          );
          // The picture is taken **now**, when the block joins the request.
          void attachPicture(mark.id);
          return;
        }

        case "capture":
          void addCaptureBlock();
          return;
      }
    },
    [annotations, boundIds, attachPicture, addCaptureBlock, addElementBlock, addBoardBlock],
  );

  /**
   * What this delivery contains: only the annotations the user explicitly named
   * (by pressing S).
   *
   * Ordered by `boundIds`, not by creation — the first stroke drawn may well be the
   * last one added. Ink never appears here: it has no block reference, so it cannot be
   * named, and it travels as a picture instead (see `previewBundle`).
   */
  const boundAnnotations = useMemo(() => {
    const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    return boundIds
      .map((id) => byId.get(id))
      .filter((annotation): annotation is Annotation => annotation !== undefined)
      .filter(isReferenceAnnotation);
  }, [annotations, boundIds]);

  /**
   * Delete one block: the target it names, and nothing else.
   *
   * ## What is *not* here any more
   *
   * The old version also rewrote the prompt text: it dropped the reference and renumbered
   * everything after it. That rewrite was the mechanism of every caret defect in this box —
   * the text changed, so the DOM had to be rebuilt, and the rebuild destroyed the node the
   * caret lived in (found.md F-116, F-117).
   *
   * Now the text is the editor's document, and **renumbering is not a text change**: a
   * block's number is its position, and its label is rendered from that position. Deleting a
   * block leaves the document untouched; the editor removes the one node and repaints the
   * rest (found.md F-118).
   */
  const removeBlock = useCallback(
    (target: BlockTarget) => {
      /*
       * Three stores, one gesture.
       *
       * Deleting a block always means "this target is no longer part of my request", but it
       * has to reach the store that actually owns it — otherwise deleting an element would
       * also unbind an annotation that happened to share a position.
       */
      /*
       * Every removal starts by leaving the request. That is the single act the box watches:
       * once the entry is gone, the chip goes with it and the numbers after it move, with no
       * text being rewritten (found.md F-118).
       */
      setOrder((current) => withoutTarget(current, target));

      if (target.kind === "capture" || target.kind === "drawing") {
        /*
         * Both kinds live in `captures`, because both are "a picture the user asked for".
         * The block kind says what the picture **is**; the store says what it takes to
         * remove it, and that part is identical.
         */
        setCaptures((current) =>
          current.filter((entry) => captureKey(entry.imagePath) !== target.id),
        );
        return;
      }

      if (target.kind === "element") {
        setElementTargets((entries) =>
          entries.filter((entry) => elementKey(entry.target) !== target.id),
        );
        return;
      }

      if (!boundIds.includes(target.id)) {
        removeAnnotation(target.id);
        return;
      }
      /*
       * Unbind, then remove. Unbinding first is what keeps the *badge* from outliving the
       * block: the canvas numbers bound marks, and a mark that is still bound but no longer in
       * the request would keep a number nothing points at.
       */
      useAnnotationStore.getState().unbind(target.id);
      removeAnnotation(target.id);
    },
    [boundIds, removeAnnotation],
  );

  /**
   * Undo the last **drawing** action.
   *
   * Scoped to shapes on purpose. The prompt box is a separate surface with its own
   * native undo stack, and it used to win this shortcut whenever the caret happened to
   * be in it — so Ctrl+Z undid typed words while the line the user had just drawn
   * stayed put. Drawing undo is the one this layer owns; text undo stays with the box.
   *
   * Returns whether anything happened. The caller uses that to decide whether to
   * consume the key: an undo that does nothing must not swallow `Ctrl+Z`, or the user
   * loses text undo in every field for the duration of annotation mode.
   */
  const undo = useCallback(() => undoShapes() !== "none", [undoShapes]);

  /** Re-apply the last undone drawing action. Returns whether anything happened. */
  const redo = useCallback(() => redoShapes() !== "none", [redoShapes]);

  /**
   * Eraser, single click: retract whatever the pointer touched.
   *
   * The tolerance is in normalized units so it stays constant on screen regardless of
   * the picture's size — the caller passes a pixel radius converted through the stage.
   */
  const eraseAtPoint = useCallback(
    (point: { x: number; y: number }, tolerance: number) => {
      eraseAt(point, tolerance);
    },
    [eraseAt],
  );

  /**
   * Eraser, press and hold: clear every mark at every timecode.
   *
   * Bound blocks survive as red, withdrawn entries — same rule as undo, because the
   * user's prompt text still names them and renumbering it behind their back would be
   * worse than a stale block.
   */
  const clearMarks = useCallback(() => {
    clearAll();
  }, [clearAll]);

  /**
   * The frame the user is looking at, as both surfaces need to name it.
   *
   * One value for one moment: the canvas and the delivered picture must select the same marks,
   * and "which frame" is the first half of that question.
   */
  const activeFrame = useMemo<FrameSelector>(() => {
    const snapshot = snapshotFrame({
      currentTime: options.currentTime,
      iframe: options.previewIframe,
      overrides: {
        activeCompPath: options.activeCompPath,
        compositionWidth: options.compositionWidth,
        compositionHeight: options.compositionHeight,
      },
    });
    return { compositionPath: snapshot.frame.compositionPath, time: snapshot.frame.time };
  }, [
    options.currentTime,
    options.previewIframe,
    options.activeCompPath,
    options.compositionWidth,
    options.compositionHeight,
  ]);

  /*
   * Keep the routing frame current.
   *
   * Assigned here rather than declared here because `addBoardBlock` above reads it through a
   * ref: the callback must not be rebuilt every time the playhead moves, and it still has to
   * see the frame that is on screen when the user presses the key.
   */
  activeFrameRef.current = activeFrame;

  /**
   * The badge number of every mark in the request, keyed by annotation id.
   *
   * The request's own order, which is also what the prompt box renders: one array decides what
   * `Arrow 2` means (found.md F-107, F-118).
   */
  const ordinals = useMemo(() => annotationOrdinals(order), [order]);

  /**
   * What is painted on this frame, each with its badge.
   *
   * **One** computation, used by the canvas and by the delivered picture. That is the whole
   * point: two computations of "which marks are on the frame, numbered how" is what let the
   * delivered image show a numbered mark the screen did not have (found.md F-122).
   */
  const frameMarks = useMemo(
    () => frameMarksFor(annotations, activeFrame, ordinals),
    [annotations, activeFrame, ordinals],
  );

  /**
   * The request as delivered: every block in the order the user added it, each carrying the
   * number that order gives it.
   *
   * ## Why the numbers are assigned here
   *
   * A block's number is its position in the request. Assigning it at the **boundary** — when
   * the bundle is built — is what lets the same number be read by the box, the canvas badges
   * and the delivered prompt without any of them storing it, and without a deletion having to
   * rewrite anything (found.md F-107, F-118).
   *
   * A block whose record has disappeared is skipped rather than delivered as a reference to
   * nothing: the order can briefly hold an entry the stores no longer have, and a prompt
   * naming a missing target is worse than a shorter prompt.
   */
  const previewBundle = useMemo<AnnotationBundle | null>(() => {
    const config = options.config;
    if (!config) return null;

    const annotationsById = new Map(boundAnnotations.map((entry) => [entry.id, entry]));
    const elementsByKey = new Map(elementTargets.map((entry) => [elementKey(entry.target), entry]));

    /*
     * Ink is delivered as a picture only while the frame still carries live strokes. The file
     * on disk still has them drawn on it, and sending it would show the reader marks the user
     * explicitly removed.
     */
    const liveCapture = (capture: InkCapture): boolean =>
      annotations.some(
        (annotation) =>
          !annotation.withdrawn &&
          annotation.shape.kind === "freehand" &&
          annotation.frame.compositionPath === capture.compositionPath &&
          Math.abs(annotation.frame.time - capture.time) < 0.0005,
      );

    const deliveredAnnotations: Annotation[] = [];
    const deliveredElements: BoundElement[] = [];
    const deliveredInk: InkCapture[] = [];

    order.forEach((entry, index) => {
      const ordinal = index + 1;
      const label = labelForTarget(entry, ordinal);

      switch (entry.kind) {
        case "annotation": {
          const annotation = annotationsById.get(entry.id);
          if (!annotation) return;
          deliveredAnnotations.push({ ...annotation, ref: label });
          return;
        }
        case "element": {
          const element = elementsByKey.get(entry.id);
          if (!element) return;
          deliveredElements.push({ ...element, ref: label });
          return;
        }
        case "capture":
        case "drawing": {
          /*
           * Both are "a picture of what the user was looking at". They differ in what the
           * picture **is** — a frame with ink on it, or a page of the user's own drawing —
           * and that difference travels on the capture itself (`board: true`), not in how it
           * is fetched or removed.
           */
          const capture = captures.find((candidate) => candidate.imagePath === entry.id);
          if (!capture) return;
          /*
           * A board sketch never goes stale.
           *
           * `liveCapture` asks "does this frame still carry live ink", which is the right
           * question for a frame: undo the strokes and the picture must go away with them. A
           * page is different — the block is a snapshot the user deliberately took, and the
           * page may since have been cleared. Dropping it then would delete a block the user
           * never deleted (found.md F-128).
           */
          if (!capture.board && !liveCapture(capture)) return;
          deliveredInk.push({ ...capture, ref: label });
          return;
        }
      }
    });

    if (
      deliveredAnnotations.length === 0 &&
      deliveredElements.length === 0 &&
      deliveredInk.length === 0
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      projectDir: config.projectDir,
      projectId: config.projectId,
      /*
       * The overview is the user's own text in the prompt box, which `renderUserPrompt` turns
       * into the request section. There is deliberately no separate summary field in the UI:
       * one place to write is enough.
       */
      summary: "",
      annotations: deliveredAnnotations.filter(isReferenceAnnotation),
      ...(deliveredInk.length > 0 ? { ink: deliveredInk } : {}),
      ...(deliveredElements.length > 0 ? { elements: deliveredElements } : {}),
      createdAt: Date.now(),
    };
  }, [boundAnnotations, annotations, elementTargets, captures, order, options.config]);

  /** Deliver to OpenCode. */
  const deliver = useCallback(async (): Promise<DeliveryOutcome | null> => {
    const bundle = previewBundle;
    if (!bundle) {
      const outcome: DeliveryOutcome = { ok: false, code: "rejected", message: "There is nothing to send yet" };
      setLastOutcome(outcome);
      return outcome;
    }

    setDelivering(true);
    try {
      /*
       * The prompt body is what the user wrote, but it contains only block references like
       * `Region 1`. `renderUserPrompt` appends the machine details that give those references
       * meaning; with an empty box it falls back to the fully generated prompt.
       */
      const prompt = renderBundleWithElements(bundle, promptText);
      const response = await fetch(BRIDGE_ROUTES.deliver, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, prompt, bundle }),
      });
      const parsed: unknown = await response.json().catch(() => null);
      const outcome = isDeliverResponse(parsed)
        ? parsed.outcome
        : ({
            ok: false,
            code: "unknown",
            message: `The delivery endpoint returned an unexpected result (HTTP ${response.status})`,
          } satisfies DeliveryOutcome);
      setLastOutcome(outcome);
      return outcome;
    } catch (error) {
      const outcome: DeliveryOutcome = {
        ok: false,
        code: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      };
      setLastOutcome(outcome);
      return outcome;
    } finally {
      setDelivering(false);
    }
  }, [previewBundle, promptText]);

  /*
   * Undo/redo are **not** handled here.
   *
   * They go through the command table in `commands.ts`, which is user-configurable and
   * is matched by the shortcut policy *before* its typing check — so `Ctrl+Z` reaches
   * the canvas even when the caret is in the prompt box. A second listener here would
   * be a duplicate implementation that could disagree with the user's own binding.
   */

  return {
    tool,
    setTool,
    /** A finished stroke; the caller passes the shape from the drawing layer. */
    handleStroke,
    addToPrompt,
    deliver,
    delivering,
    lastOutcome,
    annotations,
    frameWarning,
    /** The box's current text, published by the editor. */
    promptText,
    setPromptText,
    /**
     * The request, in the order the user added to it.
     *
     * Everything that needs a block number reads this and indexes into it; nothing else stores
     * one (found.md F-118).
     */
    order,
    boundAnnotations,
    boundIds,
    elementTargets,
    removeBlock,
    undo,
    redo,
    canUndo,
    canRedo,
    eraseAtPoint,
    clearMarks,
    /** Pictures of frames carrying handwriting, one per capture; sent as attachments. */
    inkImages,
    /** The captures the user added to the request, each with a `Capture N` block. */
    captures,
    /** The frame the user is looking at, for anything that has to name one. */
    activeFrame,
    /**
     * What is painted on this frame, each with its badge.
     *
     * The canvas renders this and the delivered picture composes it, so the two cannot disagree
     * about which marks exist or what they are numbered (found.md F-122).
     */
    frameMarks,
    /**
     * Whether there is anything at all to deliver.
     *
     * Taken from the bundle rather than from its inputs: an undone stroke leaves its
     * composed image behind until the bundle filters it out, so counting `inkImages`
     * here kept the send button enabled while `deliver` would answer "nothing to send".
     */
    hasDeliverable: previewBundle !== null,
  };
}

/**
 * The stable key of one capture block.
 *
 * `ref` is a *label*, and labels are positions now — using one as an identity would break the
 * moment a block before it is deleted. The image path is the identity: each capture owns its
 * own file and no later drawing rewrites it.
 */
/**
 * Describe an element with its box normalized against the iframe viewport.
 *
 * Not against the composition design size: `getBoundingClientRect` returns iframe
 * viewport coordinates, and the preview may be scaled (Studio fits the canvas to
 * the visible area). Normalizing against the viewport uses the same basis as the
 * mouse, so the arrow tail and the box line up.
 */
function describeElementInViewport(element: Element, doc: Document): ElementRef {
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  if (width <= 0 || height <= 0) return describeElement(element, { width: 1, height: 1 });
  return describeElement(element, { width, height });
}

/**
 * A stable, filename-safe key for a frame.
 *
 * Derived from the composition path and the time, so the same frame always produces the
 * same picture filename and a new stroke overwrites the previous image instead of
 * leaving a stale one. The time is rounded the same way the comparison elsewhere is, so
 * two strokes drawn on the "same" frame cannot produce two keys.
 */
function hashFrameKey(frame: FrameRef): string {
  const raw = `${frame.compositionPath}@${frame.time.toFixed(3)}`;
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function saveFrame(annotationId: string, pngBase64: string): Promise<SaveFrameResponse> {
  try {
    const response = await fetch(BRIDGE_ROUTES.frame, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, annotationId, pngBase64 }),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (isSaveFrameResponse(parsed)) return parsed;
    return { ok: false, error: `Saving the frame returned an unexpected result (HTTP ${response.status})` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isSaveFrameResponse(value: unknown): value is SaveFrameResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "path" in value && typeof value.path === "string";
  if (value.ok === false) return "error" in value && typeof value.error === "string";
  return false;
}

function isDeliverResponse(
  value: unknown,
): value is { outcome: DeliveryOutcome; sink: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    typeof value.outcome === "object" &&
    value.outcome !== null &&
    "ok" in value.outcome
  );
}
