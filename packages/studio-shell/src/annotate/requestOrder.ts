/**
 * The request's block order — the one thing both surfaces count from.
 *
 * ## Why order is stored and not derived
 *
 * A block's **number is its position in the request**. That is what makes `Arrow 2` in the
 * user's sentence, the badge on the picture and the chip in the box all name the same thing.
 *
 * The previous implementation derived the order from each store independently — annotations by
 * `createdAt`, elements and captures by their own counters — and then tried to sort them into
 * one list by mixing units. It never worked reliably: epoch milliseconds compared against small
 * ordinals produced an order that had nothing to do with the order the user did things in, and
 * the visible result was a number in the text that no block carried (found.md F-107, F-111).
 *
 * So the order **is state**: one array of targets, in the order they joined the request. Adding
 * appends; deleting removes; and because the number is read off the position, nothing else has
 * to be rewritten (found.md F-118).
 *
 * ## Why it lives apart from the stores
 *
 * The three stores answer "what exists": marks on the frame, elements named from Studio,
 * captures taken. This answers a different question — "what did the user ask for, and in what
 * order" — and it can name things the other three store without a notion of order.
 */

import { targetKey, type BlockShape, type BlockTarget } from "./promptSchema.js";

/** One entry of the request. */
export interface RequestEntry extends BlockTarget {
  /** Which shape, for annotation blocks, so the label reads `Arrow 2`. */
  readonly shape?: BlockShape;
}

/** Add a target to the end of the request, unless it is already there. */
export function withTarget(
  entries: readonly RequestEntry[],
  target: RequestEntry,
): readonly RequestEntry[] {
  const key = targetKey(target);
  if (entries.some((entry) => targetKey(entry) === key)) return entries;
  return [...entries, target];
}

/** Remove one target from the request. */
export function withoutTarget(
  entries: readonly RequestEntry[],
  target: Pick<BlockTarget, "kind" | "id">,
): readonly RequestEntry[] {
  const key = targetKey(target);
  return entries.filter((entry) => targetKey(entry) !== key);
}

/**
 * The badge number of every **annotation** block, keyed by annotation id.
 *
 * ## Why this is one function
 *
 * The number a mark's badge shows is its position in the **request**. That is a single fact, and
 * it was being derived twice: once in the hook from `order`, and once inside the picture capture
 * from `boundIds`. The two agree only while every bound mark is also in the request — and a mark
 * can be bound but not in `order` (an older payload, or a mark whose block was removed), at which
 * point the picture and the screen number things differently (found.md F-122).
 *
 * @param order the request, in order. Index + 1 is the number.
 */
export function annotationOrdinals(
  order: readonly Pick<RequestEntry, "kind" | "id">[],
): Map<string, number> {
  const map = new Map<string, number>();
  order.forEach((entry, index) => {
    if (entry.kind !== "annotation") return;
    map.set(entry.id, index + 1);
  });
  return map;
}
