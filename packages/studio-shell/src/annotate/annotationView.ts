/**
 * Derived views of the annotation store.
 *
 * The canvas and the delivered bundle are both renderings of one ordered list, and the box
 * reads its order from `requestOrder.ts`. Their **ordering rules** are the same rules, so they
 * live here rather than being recomputed (and re-tested) in each component:
 *
 * - **bound marks first**, in the order the user added them to the prompt, then unbound
 *   ones. That is what lets `Arrow 2` on screen be found as `Arrow 2` in the text without
 *   shifting.
 * - **withdrawn marks keep their slot**. Undoing a mark removes it from the picture, but
 *   its number stays consumed: the user's sentence still names it.
 * - **ink owns no slot**. A freehand stroke has no reference, so numbering it would make
 *   `Arrow 1` become `Arrow 2` merely because something was scribbled in between.
 *
 * Pure and React-free: the components only read what this module derives.
 */

import type { Annotation } from "@mystudio/protocol";
import { isReferenceableShape } from "@mystudio/protocol";

/**
 * The mark `S` appends when Studio has no element selected: the newest one a sentence
 * could name.
 *
 * Withdrawn marks are skipped — the user already said "that one is gone". Ink is skipped
 * because it has no block reference (see `isReferenceableShape`).
 */
export function newestReferenceable(annotations: readonly Annotation[]): Annotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (!annotation || annotation.withdrawn) continue;
    if (isReferenceableShape(annotation.shape.kind)) return annotation;
  }
  return null;
}
