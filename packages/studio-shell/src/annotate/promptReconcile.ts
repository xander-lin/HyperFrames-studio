/**
 * Keeping the document's blocks equal to the request's blocks.
 *
 * ## What this is allowed to do
 *
 * Exactly two things: **insert** a block and **delete** a block. It never touches a text node.
 * That restriction is the whole design:
 *
 * - the user's words are never rewritten, so the caret is never displaced by a rewrite;
 * - renumbering needs no document change at all, because the number is the node's position
 *   and the label is rendered from it (found.md F-118);
 * - a deletion is a local edit, so the editor's own position mapping moves the selection by
 *   the amount that was actually deleted — nothing else.
 *
 * ## Why it is a separate module
 *
 * It is the only place where "the request says these blocks" meets "the document holds those
 * blocks", and that meeting is where every previous defect in this box lived. Being pure
 * (document in, transaction out) means it is testable without rendering, and a test can state
 * the property that matters: *deleting one block leaves the text and the other blocks
 * untouched*.
 */

import { type Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { removeBlockAt } from "./promptBlockKeys.js";
import {
  blocksOf,
  blockNode,
  blockParagraph,
  targetKey,
  type BlockTarget,
} from "./promptSchema.js";

/** The document position of the paragraph holding the block at `blockPos`. */
function paragraphStart(doc: PMNode, blockPos: number): number {
  const $pos = doc.resolve(blockPos);
  return blockPos - $pos.parentOffset - 1;
}

/**
 * Add a block **on a line of its own** at the end of the document.
 *
 * ## Why its own line
 *
 * A reference is a block, not a word: the box shows it as one deletable pill, and mixing it
 * into a sentence makes "delete this block" ambiguous. The previous implementation expressed
 * the same rule by appending a line to a string; here it is a paragraph boundary, which is the
 * document's own way of saying the same thing (found.md F-107).
 *
 * A trailing empty paragraph is **reused** rather than left behind: the editor always keeps
 * one paragraph, and appending a block after it would otherwise stack a blank line under every
 * reference.
 */
function appendBlock(tr: Transaction, target: BlockTarget): void {
  const last = lastParagraph(tr.doc);
  if (!last) {
    tr.insert(tr.doc.content.size, blockParagraph(target));
    return;
  }

  const empty = last.node.childCount === 0;
  if (empty) {
    // A lone empty paragraph *is* the new block's line; fill it instead of adding another.
    tr.insert(last.start + 1, blockNode(target));
    return;
  }
  // Otherwise the block gets a paragraph of its own, after the user's last words.
  tr.insert(tr.doc.content.size, blockParagraph(target));
}

/** The last paragraph's start and node, or `null` for a document with none. */
function lastParagraph(
  doc: PMNode,
): { readonly start: number; readonly node: PMNode } | null {
  if (doc.childCount === 0) return null;
  let start = 0;
  let node: PMNode | null = null;
  doc.forEach((child, offset) => {
    start = offset;
    node = child;
  });
  return node ? { start, node } : null;
}

/**
 * One transaction that makes the document's blocks equal `desired`, or `null` when it already
 * does.
 *
 * Returning `null` matters: dispatching a transaction that changes nothing still normalises the
 * selection, and that alone can move the caret to the end of the document. The caller has to be
 * able to skip dispatch entirely.
 */
export function reconcileTransaction(
  doc: PMNode,
  tr: Transaction,
  desired: readonly BlockTarget[],
): Transaction | null {
  const desiredKeys = desired.map(targetKey);
  const currentKeys = blocksOf(doc).map((block) => targetKey(block.target));
  if (sameSequence(currentKeys, desiredKeys)) return null;

  /*
   * Phase 1: remove every block the request no longer names, and every **duplicate**.
   *
   * Going backwards means each deletion leaves the positions of the blocks still to be
   * examined untouched. Clearing duplicates here is what makes phase 2 safe: it can then
   * assume the document holds a set of distinct, still-wanted blocks.
   */
  const wanted = new Set(desiredKeys);
  const seen = new Set<string>();
  for (const block of blocksOf(tr.doc).reverse()) {
    const key = targetKey(block.target);
    if (wanted.has(key) && !seen.has(key)) {
      seen.add(key);
      continue;
    }
    removeBlockAt(tr, block.pos);
  }

  /*
   * Phase 2: put the blocks that are present-but-out-of-order in place, and add the missing
   * ones.
   *
   * Each pass fixes the **first** position where the document and the request disagree, which
   * makes progress provable: the matching prefix grows by one every iteration, or an extra
   * block is removed. Reading positions fresh each pass is what keeps this simple — no step has
   * to predict how an earlier edit shifted a later position.
   *
   * The two cases matter and are easy to get wrong:
   *
   * - the wanted block is **elsewhere** in the document — it has to be *moved*, not copied.
   *   Inserting a second copy is how a reorder used to leave a duplicate behind and then read
   *   past the end of the request (found.md F-121);
   * - it is **absent** — insert it before whatever sits at this position now.
   */
  for (let guard = 0; guard < 1000; guard += 1) {
    const placed = blocksOf(tr.doc);
    const keys = placed.map((block) => targetKey(block.target));
    const index = firstDivergence(keys, desiredKeys);
    if (index === null) break;

    // The document holds a block the request does not name. Phase 1 should have removed it;
    // removing it here guarantees progress rather than looping forever.
    if (index >= desiredKeys.length) {
      const extra = placed[index];
      if (extra) removeBlockAt(tr, extra.pos);
      continue;
    }

    const wantedKey = desiredKeys[index]!;
    const elsewhere = placed.findIndex((block) => targetKey(block.target) === wantedKey);
    if (elsewhere >= 0) {
      removeBlockAt(tr, placed[elsewhere]!.pos);
      const anchor = blocksOf(tr.doc)[index];
      if (anchor) tr.insert(paragraphStart(tr.doc, anchor.pos), blockParagraph(desired[index]!));
      else appendBlock(tr, desired[index]!);
      continue;
    }

    const anchor = placed[index];
    if (anchor) tr.insert(paragraphStart(tr.doc, anchor.pos), blockParagraph(desired[index]!));
    else appendBlock(tr, desired[index]!);
  }

  return tr.docChanged ? tr : null;
}

/** The first index at which two key sequences disagree, or `null` when they agree. */
function firstDivergence(current: readonly string[], desired: readonly string[]): number | null {
  const length = Math.max(current.length, desired.length);
  for (let index = 0; index < length; index += 1) {
    if (current[index] !== desired[index]) return index;
  }
  return null;
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
