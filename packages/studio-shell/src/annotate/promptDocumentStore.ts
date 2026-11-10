/**
 * The prompt document, held outside the component that shows it.
 *
 * ## Why this module exists
 *
 * The editor is a React child of a floating panel that is mounted only while the layer is
 * active: pressing the activation key unmounts it and pressing it again mounts a new one. With
 * the document owned *inside* the component, that remount started from a fresh, empty tree —
 * so deactivating and reactivating silently threw away everything the user had typed.
 *
 * The document therefore lives here, in one mutable holder, and the component adopts whatever is
 * here when it mounts. That is also the honest model: the prompt is **one** document for the
 * session, and whether it is currently on screen is a property of the view, not of the text.
 *
 * ## Why not React state
 *
 * React state belongs to the component, and this value has to outlive it. Keeping it in the hook
 * above would work too, but it would push ProseMirror's `EditorState` through a hook that has no
 * other reason to know about editors — and the one thing this module does (hold one value) is
 * cheaper to reason about than threading state through two layers.
 *
 * ## What is deliberately absent
 *
 * No persistence, no history, no schema: it holds exactly one `EditorState | null` for the life
 * of the page. Restoring a prompt across a *restart* is a different question (the captures behind
 * its blocks would not exist yet), and pretending to solve it here would be a half-answer.
 */

import type { EditorState } from "prosemirror-state";

let current: EditorState | null = null;

/** The document the box had the last time it was on screen, if any. */
export function heldEditorState(): EditorState | null {
  return current;
}

/** Remember the document, so the next mount of the box starts where this one left off. */
export function holdEditorState(state: EditorState): void {
  current = state;
}

/**
 * Forget the document.
 *
 * Called when the prompt is emptied on purpose. Without it, an emptied box would come back
 * filled after a deactivate/reactivate cycle, because the module still holds the old tree.
 */
export function releaseEditorState(): void {
  current = null;
}
