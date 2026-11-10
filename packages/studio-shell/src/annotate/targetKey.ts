/**
 * Stable identities for the things a request can name.
 *
 * ## Why these are not the block's label
 *
 * A block's label is its **position** in the request (`Element 2`, `Capture 3`), so it changes
 * whenever anything before it is deleted. Using a label as an identity would make a block stop
 * being recognised the moment its number moved — the class of bug behind the chips that turned
 * into plain text (found.md F-108, F-118).
 *
 * So identity comes from what the thing **is**: which fields identify an element in the DOM, and
 * which file holds a capture's picture.
 *
 * ## Why they live here
 *
 * They are read by the stores, by the request order and by the delivery, and a test asserting
 * "the same element twice is one block" has to use the same rule the product does. A copy of
 * this rule in a test file is a copy that can silently disagree.
 */

import type { ElementTarget } from "@mystudio/protocol";

/**
 * The identity of one element block.
 *
 * `selector` + `selectorIndex` + `hfId` together, because any one is ambiguous on its own: a
 * selector matches several nodes (which is what the index is for), and an element can have no
 * `hfId` at all.
 */
export function elementKey(target: ElementTarget): string {
  return `${target.selector ?? ""}#${target.selectorIndex ?? 0}#${target.hfId ?? ""}`;
}

/**
 * The identity of one capture block: the file that holds its picture.
 *
 * Every capture owns its own file and no later drawing rewrites it, so the path is stable for
 * exactly as long as the block exists.
 */
export function captureKey(imagePath: string): string {
  return imagePath;
}

/**
 * Whether adding this element to a request would be a **second block for the same thing**.
 *
 * The user means "this element" when they add it; two blocks pointing at the same node would
 * claim two changes had been asked for.
 */
export function hasElement(
  entries: readonly { readonly target: ElementTarget }[],
  target: ElementTarget,
): boolean {
  const key = elementKey(target);
  return entries.some((entry) => elementKey(entry.target) === key);
}
