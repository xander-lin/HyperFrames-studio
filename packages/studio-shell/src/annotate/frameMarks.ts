/**
 * What is drawn on one frame, and which badge each mark carries.
 *
 * ## Why this is one function
 *
 * The canvas and the delivered picture draw the same thing. They used to decide **what to draw
 * and how to number it** separately:
 *
 * - the canvas asked `numberedMarks(marks, ordinals)`, whose numbers come from the **request's**
 *   order;
 * - `capturePictureArea` had its own loop that counted up every referenceable mark on the frame.
 *
 * Two counters for one number means two answers, and the difference is not academic: the
 * delivered picture showed a mark the screen did not, because the two disagreed about whether a
 * mark had been added to the request. A mark that is **on the frame but not in the request has
 * no number**, so painting one onto the delivered image invents a reference the user never
 * asked for (found.md F-122).
 *
 * So the decision is made once, here, from the same inputs both surfaces already have, and both
 * call it. `shapePainter.ts` already made the *drawing* shared; this makes the *selection and
 * numbering* shared, which is the half that was still duplicated.
 */

import type { Annotation } from "@mystudio/protocol";
import { isReferenceableShape } from "@mystudio/protocol";

/** One thing to paint, with the badge it shows (or `null` for none). */
export interface FrameMark {
  readonly id: string;
  readonly shape: Annotation["shape"];
  /** `"3"` for the third block in the request; `null` when the mark has no reference. */
  readonly badge: string | null;
}

/** Which frame to select marks for. */
export interface FrameSelector {
  readonly compositionPath: string;
  readonly time: number;
}

/** Two times describe the same frame when they differ by less than this. */
const TIME_EPSILON = 0.0005;

/**
 * The marks to paint for one frame, in painting order, each with its badge.
 *
 * ## The two things this decides
 *
 * 1. **Which marks belong to this frame** — same composition, same time. A mark drawn on another
 *    frame is not part of this picture.
 * 2. **What each one's badge is** — read from `ordinals`, the request's own order. A mark that is
 *    on the frame but not in the request has **no** badge: nothing refers to it by number, so
 *    giving it one would invent a reference.
 *
 * Withdrawn marks are dropped: they are gone from the picture, and the block that names them is
 * rendered red in the prompt instead of being painted here.
 *
 * @param ordinals annotation id → 1-based position in the request. Marks absent from this map
 * are on the frame only, and get no badge.
 */
export function frameMarks(
  annotations: readonly Annotation[],
  frame: FrameSelector,
  ordinals: ReadonlyMap<string, number>,
): FrameMark[] {
  return annotations
    .filter(
      (annotation) =>
        !annotation.withdrawn &&
        annotation.frame.compositionPath === frame.compositionPath &&
        Math.abs(annotation.frame.time - frame.time) < TIME_EPSILON,
    )
    /*
     * Painting order is creation order — see `paintOrder`.
     *
     * Deliberately **not** the request's order: a number is a name, not a z-index, and promoting
     * a mark in the prompt must not reorder the picture.
     */
    .slice()
    .sort((a, b) => paintOrder(a) - paintOrder(b))
    .map((annotation) => {
      const ordinal = ordinals.get(annotation.id);
      const numbered = isReferenceableShape(annotation.shape.kind) && ordinal !== undefined;
      return {
        id: annotation.id,
        shape: annotation.shape,
        badge: numbered ? String(ordinal) : null,
      };
    });
}

/**
 * Painting order for one frame: **creation order**.
 *
 * ## Why not request order
 *
 * A number says *what the mark is called*, not *where it is painted*. Ordering the canvas by
 * request position would move a mark in front of another purely because the user promoted it in
 * the prompt — a visual change caused by an unrelated action, and one that silently changes what
 * overlaps what.
 *
 * Creation order is also what the canvas has always used, so the picture keeps looking the way
 * the user drew it (found.md F-122).
 */
function paintOrder(annotation: Annotation): number {
  return annotation.createdAt;
}
