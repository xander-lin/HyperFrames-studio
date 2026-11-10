/**
 * Normalized coordinates. The origin is the top-left corner of the composition
 * canvas, with x/y in 0..1 regardless of the canvas' pixel size.
 *
 * Pixels are not stored because an annotation may be re-rendered at a different
 * zoom or window size (replay, thumbnails, the high-resolution frame sent to the
 * agent). Normalized coordinates reproduce the exact same position at any size.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Normalized rectangle. width/height may be 0 (degenerating to a point or line). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The "frame" an annotation refers to — the composition as it looks at one
 * moment on the video timeline.
 *
 * `time` is the composition's local time in seconds, not global timeline time.
 * The two are equal for a single composition and diverge inside sub-compositions,
 * so they must be expressed separately.
 */
export interface FrameRef {
  /** Composition path relative to the project root, e.g. `index.html`. */
  readonly compositionPath: string;
  /** Playhead position inside that composition, in seconds. */
  readonly time: number;
  /** Design size of the composition canvas, used to restore pixel coordinates. */
  readonly compositionWidth: number;
  readonly compositionHeight: number;
}

/**
 * The element an annotation points at.
 *
 * Every field is optional: regions and freehand strokes are not bound to an
 * element at all, and an arrow may point "somewhere" rather than at one.
 * `hfId` is Hyperframes' stable id (`data-hf-id`), which survives reflow better
 * than a CSS selector.
 */
export interface ElementRef {
  readonly hfId?: string;
  readonly id?: string;
  readonly tagName?: string;
  /** CSS selector that uniquely locates the element; only a fallback for a missing hfId. */
  readonly selector?: string;
  /** Ordinal when the same selector matches multiple elements. */
  readonly selectorIndex?: number;
  /** Element bounding box in this frame, normalized. */
  readonly box?: Rect;
  /** Element text content (truncated). Very useful for locating text elements. */
  readonly text?: string;
}

/** Region: a rectangular area, not bound to an element. */
export interface RegionAnnotation {
  readonly kind: "region";
  readonly rect: Rect;
}

/**
 * Arrow: from one point to another.
 *
 * `from` is the tail (usually on the element being moved), `to` is the head (the
 * target position). The semantics are "move the thing at from to to", so the
 * optional `element` describes what `from` points at.
 */
export interface ArrowAnnotation {
  readonly kind: "arrow";
  readonly from: Point;
  readonly to: Point;
  readonly element?: ElementRef;
}

/**
 * One sample of a hand-drawn stroke.
 *
 * `pressure` is the pen's reported pressure in 0..1, captured because this layer is
 * meant to feel like writing on a tablet: the same gesture with a light or heavy hand
 * must look different. It is **absent** for a mouse, which has no pressure at all and
 * reports a flat 0.5 — storing that would claim a measurement that was never made, and
 * the renderer would then thicken every mouse stroke as if the user were pressing hard.
 */
export interface InkPoint extends Point {
  readonly pressure?: number;
}

/**
 * Freehand: ink the user drew by hand.
 *
 * Deliberately shaped like pen input rather than like a diagram: a freehand stroke is
 * not a pointer at something, it *is* the content. See `isReferenceableShape` for the
 * consequence — ink is never numbered.
 */
export interface FreehandAnnotation {
  readonly kind: "freehand";
  readonly points: readonly InkPoint[];
  /**
   * Ink colour, `#rrggbb`.
   *
   * Optional rather than required so an existing stroke, or one recorded before colours
   * existed, has a defined meaning: absent means the default annotation colour. A
   * required field would make every old payload invalid for no gain.
   */
  readonly colour?: string;
  /**
   * Base stroke width in CSS pixels at scale 1.
   *
   * Pressure still varies the width *within* a stroke; this scales the whole range. Stored
   * on the stroke rather than read from current UI state because the stroke must keep
   * looking the way it was drawn when reopened later, at another zoom, or in the delivered
   * image.
   */
  readonly width?: number;
}

export type AnnotationShape = RegionAnnotation | ArrowAnnotation | FreehandAnnotation;

/** The kinds that name something on the frame, and therefore get a number. */
export type ReferenceableKind = "region" | "arrow";

/**
 * Whether a shape kind is named by a block reference such as `Region 1`.
 *
 * ## Why ink is not
 *
 * A number exists to connect three things: the badge on the canvas, the block in the
 * prompt text, and the heading in the delivered prompt. That connection is needed when
 * the user writes *about* a mark — "move Arrow 2 left".
 *
 * Handwriting is different. Its meaning is the shape of the stroke, and a number adds
 * nothing a reader can use: "Freehand 3" tells the model only that there were two
 * others. Worse, numbering it would consume an ordinal, so `Arrow 1` could become
 * `Arrow 2` merely because the user scribbled something in between — silently
 * repointing a sentence they already wrote.
 *
 * So ink carries no number and owns no slot, and it reaches the reader the only way the
 * stroke can: as part of the picture.
 */
export function isReferenceableShape(kind: AnnotationShape["kind"]): kind is ReferenceableKind {
  return kind === "region" || kind === "arrow";
}

/** An annotation whose shape names something, and therefore owns a block number. */
export type ReferenceAnnotation = Annotation & {
  readonly shape: RegionAnnotation | ArrowAnnotation;
};

/** Narrow a stored annotation to the referencable ones. */
export function isReferenceAnnotation(annotation: Annotation): annotation is ReferenceAnnotation {
  return isReferenceableShape(annotation.shape.kind);
}

/**
 * A complete annotation = shape + frame + optional element + user note + a
 * capture of that frame.
 *
 * `id` is generated by the creator and unique within the project, so the
 * annotation can later be edited, deleted or replayed.
 */
export interface Annotation {
  readonly id: string;
  readonly shape: AnnotationShape;
  readonly frame: FrameRef;
  /** Extra intent written by the user. May be empty — the shape already carries information. */
  readonly note: string;
  /** Absolute path or file:// URL of a clean capture of that frame (without annotation graphics). */
  readonly frameImagePath?: string;
  readonly element?: ElementRef;
  /**
   * The drawing this annotation describes is gone from the frame.
   *
   * Undo and the eraser remove a mark without touching the prompt text the user
   * wrote — they never asked to edit their words. The block therefore stays where it
   * is (so block references keep pointing at the same ordinal) but is marked
   * withdrawn, and the interface paints it red: "you are referring to something that
   * is no longer on the picture".
   *
   * It is a domain fact, not a UI flag: the delivered prompt states it plainly, so an
   * agent is never asked to act on a mark that does not exist.
   */
  readonly withdrawn?: boolean;
  /** Creation time, Unix milliseconds. */
  readonly createdAt: number;
  /**
   * The block reference this mark is delivered under, e.g. `Arrow 2`.
   *
   * Filled in **at delivery time** from the block's position in the request, not stored by the
   * interface: a number is a position, and storing one would mean rewriting every later block
   * whenever one is deleted (found.md F-118).
   *
   * Absent in older payloads, in which case the renderer falls back to the list position — the
   * same thing, for a bundle whose order happens to be the mark order.
   */
  readonly ref?: string;
}

/** One delivery: a set of annotations plus the project they belong to. */
export interface AnnotationBundle {
  /** Protocol version, so a receiver can reject payloads it does not understand. */
  readonly schemaVersion: 1;
  /** Absolute path of the Hyperframes project root. */
  readonly projectDir: string;
  /** The project's id inside Studio. */
  readonly projectId: string;
  /** A one-line summary the user wrote for the whole batch. May be empty. */
  readonly summary: string;
  /**
   * The numbered marks this delivery names, in block order.
   *
   * Only referencable shapes: handwriting is not a block (see `isReferenceableShape`)
   * and reaches the reader as a picture through `ink` instead.
   */
  readonly annotations: readonly ReferenceAnnotation[];
  /**
   * Frames that carry handwriting but no numbered mark.
   *
   * Ink is content, not a reference: it is delivered as a picture of the frame **as it
   * looks with the strokes on it**, and described in one line rather than one block per
   * stroke. Without this field, a frame the user only scribbled on would have nowhere
   * to travel — no annotation would name it, and the picture would never be sent.
   */
  readonly ink?: readonly InkCapture[];
  /**
   * Elements added from Studio's own selection.
   *
   * Carried in the bundle rather than merged into `annotations` because the two are
   * described differently: an annotation is defined by **where it is on the frame**, an
   * element by **what it is in the DOM**. Flattening them would force one of the two to
   * misrepresent itself, and would make `annotations` — a list of numbered marks — contain
   * things that are not marks.
   */
  readonly elements?: readonly BoundElement[];
  readonly createdAt: number;
}

/**
 * An element the user named in the request, with the block reference it owns.
 *
 * ## Why it carries a picture
 *
 * A selector identifies an element for a reader that can browse the project, but the user's
 * intent is about **what they were looking at**. Two reasons to send the frame:
 *
 * 1. the picture shows the element **in context** — size on screen, what is around it,
 *    whether it is even visible at this timecode;
 * 2. a selector can be ambiguous after an edit, and the picture is the fallback that lets a
 *    reader see what the user meant instead of trusting a stale query.
 *
 * The element's own description (tag, selector, text, source file) stays: the picture says
 * *which thing*, the description says *how to find it in the code*. Neither replaces the
 * other.
 */
export interface BoundElement {
  /**
   * The block reference, e.g. `Element 2`.
   *
   * Assigned **at delivery time** from the block's position in the request, not stored by the
   * interface: a number is a position, and storing it would mean rewriting every later block
   * whenever one is deleted (found.md F-118). Absent while the element is only in the box.
   */
  readonly ref?: string;
  /**
   * Creation order across **all** block kinds.
   *
   * The number in a reference is the block's position in one request-wide sequence, not a
   * per-kind counter: `Element 1`, `Capture 2`, `Capture 3` (found.md F-107). Storing the
   * order rather than the number lets a deletion renumber everything consistently.
   */
  readonly seq?: number;
  /** What the element is. Plain data; see `elementRequest.ts`. */
  readonly target: ElementTarget;
  /**
   * The frame the element was selected on.
   *
   * ## Why an element needs this
   *
   * Its `frameImagePath` is a picture of **one specific frame**, and without the frame a reader
   * holding that picture has no way to reproduce it. Worse, in a request that touches two
   * compositions, "the current video" names neither: the reader would look for the element at
   * the timecode of some unrelated mark and conclude the picture does not match.
   *
   * So an element states where it is, exactly like a region or an arrow. Optional because a
   * payload produced before this field existed is still readable — it just cannot be located.
   */
  readonly frame?: FrameRef;
  /**
   * Clean capture of the frame the element was selected on.
   *
   * Optional so an older payload, or a failed capture, still describes the element.
   */
  readonly frameImagePath?: string;
}

/**
 * An element, as a request describes it.
 *
 * Plain data with no DOM types: the caller reads the live element and hands over what
 * matters, so the format module stays testable and any host can produce one.
 */
export interface ElementTarget {
  readonly id?: string | null;
  readonly selector?: string | null;
  readonly selectorIndex?: number | null;
  readonly tagName: string;
  readonly label?: string | null;
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly text?: string | null;
  readonly sourceFile?: string | null;
  readonly src?: string | null;
  readonly hfId?: string | null;
}

/**
 * One "this is what the frame looks like now" image, produced from ink on it.
 *
 * ## Why captures are numbered and accumulate
 *
 * A capture is the result of **one drawing action**, kept under its own number (`Capture 3`)
 * rather than overwriting the frame's previous picture. The user's rule: draw, add a capture,
 * write a sentence, draw again, add another — each is a distinguishable state a reader can
 * follow, and the later one does not erase the evidence of the earlier one.
 *
 * The reference is what makes a capture **deletable from the prompt box** like any other
 * block: a picture with no visible marker meant the user could not tell it was going to be
 * sent, and could not take it back (found.md F-104).
 */
export interface InkCapture {
  /** Composition path relative to the project root. */
  readonly compositionPath: string;
  /** Playhead position inside that composition, in seconds. */
  readonly time: number;
  /** Absolute path of the composed image: the clean frame plus the strokes. */
  readonly imagePath: string;
  /** Block reference, e.g. `Capture 2`. Absent only in payloads from before captures existed. */
  readonly ref?: string;
  /** Creation order across all block kinds; see `BoundElement.seq`. */
  readonly seq?: number;
  /** How many strokes this picture shows, for the prompt's one-line summary. */
  readonly strokes?: number;
  /**
   * Set for a **whiteboard** sketch rather than a moment of the video.
   *
   * The board has no playhead and no composition: its "frame" is a page of the user's own
   * drawing, at the video's size. Saying so is what keeps the delivered prompt honest —
   * without this flag a sketch would be described with a composition path and a timecode it
   * does not have, and the reader would go looking for footage that is not there
   * (found.md F-128).
   *
   * `compositionPath` / `time` are still present and meaningful for routing (they identify
   * the frame the board replaced), but a board capture must not be **described** with them.
   */
  readonly board?: boolean;
}

/** Format a time as `mm:ss.mmm` (or `h:mm:ss.mmm` past one hour). */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.000";
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const tail = `${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
  return h > 0 ? `${h}:${tail}` : tail;
}

/**
 * Describe a timecode in both a human phrasing and the raw format, e.g.
 * "at 00:12.500 (mm:ss.mmm)", so the reader cannot misread it.
 */
export function describeTime(seconds: number): string {
  const tc = formatTimecode(seconds);
  return `at ${tc} (mm:ss.mmm)`;
}
