/**
 * Turning Studio's element selection into something the prompt box can hold.
 *
 * ## Why this is separate from the protocol builder
 *
 * `elementRequest.ts` is pure and takes plain data. This module is the other half: it
 * reads a live `DomEditSelection` (which carries a real `HTMLElement`, computed styles
 * and Studio-specific fields) and converts it into that plain data. Keeping the two
 * apart means the request format is testable without a DOM, and the conversion — which
 * *is* DOM-shaped — is the only part that needs one.
 *
 * ## What the prompt box gets, and what it does not
 *
 * The box shows **block references only**, by design: coordinates, selectors and capture
 * paths are machine details attached at delivery time. That rule does not change here.
 *
 * So pressing `S` on a selected element adds a **reference to that element**, in the same
 * form as an annotation block (`Region 1`, `Arrow 2`). The block's full detail — selector,
 * source file, box, markup — travels with the delivery, keyed by the same reference.
 *
 * The consequence is the important part: an element block needs no screenshot, because a
 * selector identifies it exactly, and it needs no coordinates in the box, because the
 * user writes about *the thing*, not about pixels.
 */

import type { ElementTarget } from "@mystudio/protocol";

/**
 * The fields this module needs from a Studio selection.
 *
 * Structural rather than importing `DomEditSelection`: the annotation layer must not
 * depend on the DOM-editing module's internals, and a narrower input is easier to fake
 * in a test than a full selection object.
 */
export interface SelectionLike {
  readonly tagName: string;
  readonly label?: string;
  readonly id?: string | null;
  readonly hfId?: string;
  readonly selector?: string;
  readonly selectorIndex?: number;
  readonly sourceFile?: string;
  readonly compositionPath?: string;
  readonly boundingBox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly textContent?: string | null;
  readonly dataAttributes?: Readonly<Record<string, string>>;
}

/** Whether a value is worth putting in a request (non-empty after trimming). */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Convert a Studio selection into a request target.
 *
 * The stable id wins the `label` slot when there is one: a selector can match several
 * elements, and `data-hf-id` is what HyperFrames itself uses to identify a node across
 * reflows. The user-facing label is still reported as a human name.
 */
export function toElementTarget(selection: SelectionLike): ElementTarget {
  const hfId = present(selection.hfId) ?? present(selection.dataAttributes?.["data-hf-id"]);
  return {
    tagName: selection.tagName,
    ...(present(selection.label) ? { label: present(selection.label) } : {}),
    ...(present(selection.id) ? { id: present(selection.id) } : {}),
    ...(hfId ? { hfId } : {}),
    ...(present(selection.selector) ? { selector: present(selection.selector) } : {}),
    ...(typeof selection.selectorIndex === "number" ? { selectorIndex: selection.selectorIndex } : {}),
    ...(present(selection.sourceFile) ? { sourceFile: present(selection.sourceFile) } : {}),
    ...(present(selection.textContent) ? { text: present(selection.textContent) } : {}),
    ...(selection.boundingBox ? { box: selection.boundingBox } : {}),
  };
}
