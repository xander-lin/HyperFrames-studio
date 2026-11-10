/**
 * Deleting a block with the keyboard.
 *
 * ## Why the editor cannot be left to do it
 *
 * A block is an atom inside a paragraph. Pressing Backspace at it makes the editor remove
 * **the node** and leave its paragraph behind, so the box accumulates blank lines — one per
 * deletion — and the remaining references drift apart. The mouse path (deleting through the
 * request) already took the paragraph with it, so the two ways of deleting the same thing
 * disagreed (found.md F-118).
 *
 * ## What this does instead
 *
 * The same thing either way: the paragraph goes with the block, unless the paragraph also
 * carries the user's words — in which case only the node goes, because a block named *inside*
 * a sentence must not take the sentence with it.
 */

import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, type EditorState, type Transaction } from "prosemirror-state";

/** The document position of the paragraph holding the block at `blockPos`. */
function paragraphStart(doc: EditorState["doc"], blockPos: number): number {
  const $pos = doc.resolve(blockPos);
  return blockPos - $pos.parentOffset - 1;
}

/**
 * Delete the block at `pos`, taking its paragraph when that paragraph holds nothing else.
 *
 * Shared with reconciliation on purpose: the keyboard and the request must leave the document
 * in the same state, and two implementations of "remove a block" would drift.
 */
export function removeBlockAt(tr: Transaction, pos: number): void {
  const $pos = tr.doc.resolve(pos);
  const paragraph = $pos.parent;
  const onlyChild = paragraph.childCount <= 1;

  if (onlyChild && tr.doc.childCount > 1) {
    const start = paragraphStart(tr.doc, pos);
    tr.delete(start, start + paragraph.nodeSize);
    return;
  }
  tr.delete(pos, pos + 1);
}

/**
 * The position of the block the caret is next to, or `null`.
 *
 * `"backward"` is the atom ending at the caret (what Backspace removes); `"forward"` is the
 * one starting there (what Delete removes). A `NodeSelection` on the block counts for both —
 * that is what clicking a chip gives.
 *
 * Returns `null` for **any caret that is not exactly at a block's edge**, which includes the
 * ordinary case of typing in the middle of a sentence. That is deliberate: the command must
 * decline there so the editor's own Backspace runs. Getting this wrong does not merely fail to
 * delete a block — it throws out of the key handler and Backspace stops working in the whole
 * field (found.md F-121).
 */
function blockBesideCaret(state: EditorState, direction: "backward" | "forward"): number | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === "block") {
    return selection.from;
  }
  if (!selection.empty) return null;

  const { $from } = selection;
  const parent = $from.parent;
  const offset = $from.parentOffset;

  if (direction === "backward") {
    if (parent.type.name === "paragraph" && offset > 0) {
      const index = childEndingAt(parent, offset);
      if (index < 0) return null;
      const node = parent.child(index);
      return node.type.name === "block" ? $from.pos - node.nodeSize : null;
    }
    /*
     * At a paragraph start the block belongs to the **previous** paragraph, so it is read
     * across the boundary. Inside a paragraph the answer comes from the paragraph's own
     * children (above), because the caret's own boundary is what Backspace acts on.
     */
    const before = $from.nodeBefore;
    return before && before.type.name === "block" ? $from.pos - before.nodeSize : null;
  }

  if (parent.type.name === "paragraph" && offset < parent.content.size) {
    const index = childStartingAt(parent, offset);
    if (index < 0) return null;
    const node = parent.child(index);
    return node.type.name === "block" ? $from.pos : null;
  }
  const after = $from.nodeAfter;
  return after && after.type.name === "block" ? $from.pos : null;
}

/** The index of the child that ends exactly at `offset`, or -1 when none does. */
function childEndingAt(parent: PMNode, offset: number): number {
  let end = 0;
  for (let index = 0; index < parent.childCount; index += 1) {
    end += parent.child(index).nodeSize;
    if (end === offset) return index;
  }
  return -1;
}

/** The index of the child that starts exactly at `offset`, or -1 when none does. */
function childStartingAt(parent: PMNode, offset: number): number {
  let start = 0;
  for (let index = 0; index < parent.childCount; index += 1) {
    if (start === offset) return index;
    start += parent.child(index).nodeSize;
  }
  return -1;
}

/**
 * A keymap command that removes the block beside the caret, or declines.
 *
 * Declines when the document would not change, so a keypress is never consumed without an
 * effect: a consumed Backspace that deleted nothing is a keystroke the user loses silently.
 */
export function removeBlockCommand(direction: "backward" | "forward") {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const pos = blockBesideCaret(state, direction);
    if (pos === null) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    removeBlockAt(tr, pos);
    if (!tr.docChanged) return false;
    dispatch(tr);
    return true;
  };
}
