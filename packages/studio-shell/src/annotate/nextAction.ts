/**
 * What the last action was, and therefore what `Ctrl+S` adds.
 *
 * ## Why this is one function and not three branches
 *
 * The rule the product has always stated is simple: **one press, one block**, and the block's
 * kind is decided by what the user just did. What made it complicated was that the decision was
 * spread over three places, each with its own copy of "does this count?":
 *
 * - the shortcut handler in `mount.tsx` picked between the selected element and the newest mark;
 * - `addElementToPrompt`, after adding `Element N`, *also* called `addCaptureBlock`;
 * - `addToPrompt` decided between a reference and a capture and fell back to a capture.
 *
 * With the decision in three places, one press could reach two of them — which is exactly how
 * `Ctrl+S` on a selected element produced `Element 1` **and** `Capture 2`, the same picture twice
 * (found.md F-122).
 *
 * So the kind is decided **once**, here, from a description of the last action, and the caller
 * does exactly one thing with the answer.
 *
 * ## The kinds
 *
 * | last action | block | why |
 * |---|---|---|
 * | element selected in Studio | `Element N` | the element is what the user pointed at; the block carries its own frame picture |
 * | a region drawn | `Region N` | the rectangle is the reference; the picture shows what is inside |
 * | an arrow drawn | `Arrow N` | the displacement is its content, so it also states both points |
 * | handwriting only | `Capture N` | ink has no reference to name, so the picture **is** the block |
 *
 * A region or arrow that was already added is **not** added twice: the answer then falls through
 * to whatever is newest and not yet in the request, which is what makes repeated presses settle
 * instead of piling up.
 */

import type { Annotation, ElementTarget, ReferenceAnnotation } from "@mystudio/protocol";
import { isReferenceAnnotation } from "@mystudio/protocol";

/** What `Ctrl+S` should add: one kind, decided once. */
export type NextAction =
  /** The element Studio has selected, which the user just pointed at. */
  | { readonly kind: "element"; readonly target: ElementTarget }
  /** A drawn region or arrow, by id, which still needs to join the request. */
  | { readonly kind: "mark"; readonly annotation: ReferenceAnnotation }
  /** Handwriting is the newest thing on the frame: the picture is the block. */
  | { readonly kind: "capture" };

/** Everything the decision depends on, so it can be tested without the editor. */
export interface LastActionInput {
  /** Studio's current element selection, if any. */
  readonly selected: ElementTarget | null;
  /** Whether that element is already a block in the request. */
  readonly selectedAlreadyAdded: boolean;
  /** Every mark on the frame, in creation order. */
  readonly annotations: readonly Annotation[];
  /** Marks already in the request, by id. */
  readonly bound: readonly string[];
}

/**
 * The newest mark **of any kind**, including ink, or `null`.
 *
 * Withdrawn marks are skipped: the user already said that one is gone.
 */
function newestMark(annotations: readonly Annotation[]): Annotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (!annotation || annotation.withdrawn) continue;
    return annotation;
  }
  return null;
}

/**
 * The newest referenceable mark that is not in the request yet, or `null`.
 *
 * Skipping already-added marks is what makes a second press settle: it moves on to the next
 * thing the user might mean instead of adding a duplicate, and when nothing is left it reports
 * `null` so the caller can fall through to a capture.
 */
function newestUnaddedMark(
  annotations: readonly Annotation[],
  bound: readonly string[],
): ReferenceAnnotation | null {
  const boundSet = new Set(bound);
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (!annotation || annotation.withdrawn) continue;
    if (boundSet.has(annotation.id)) continue;
    if (isReferenceAnnotation(annotation)) return annotation;
  }
  return null;
}

/**
 * Decide what the last action was.
 *
 * Order matters, and each step is a **deliberate act** outranking an inference:
 *
 * 1. a selected element is something the user pointed at just now;
 * 2. the newest mark is an inference about which drawing is current, so it comes after;
 * 3. ink is the last resort, and only when it is newer than any mark — a scribble made after a
 *    circle is what the user means, while a circle made after a scribble is what they mean.
 */
export function decideNextAction(input: LastActionInput): NextAction {
  const { selected, selectedAlreadyAdded, annotations, bound } = input;

  if (selected && !selectedAlreadyAdded) {
    return { kind: "element", target: selected };
  }

  const newest = newestMark(annotations);
  if (newest && newest.shape.kind === "freehand") {
    /*
     * Ink is the newest thing, so the picture is the block — even if an older region is still
     * unadded. Adding the region instead would silently ignore what the user just drew.
     */
    return { kind: "capture" };
  }

  const mark = newestUnaddedMark(annotations, bound);
  if (mark) return { kind: "mark", annotation: mark };

  /*
   * Nothing new to name. If the frame carries ink that has not been added yet, the picture is
   * still worth adding — that is "I scribbled and pressed Ctrl+S" with nothing else pending.
   * Otherwise the caller's capture path will find no ink and decline, which is correct.
   */
  return { kind: "capture" };
}
