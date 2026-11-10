/**
 * What the screen sprite lists under "Available now".
 *
 * One pure function rather than a `useMemo` buried in the mount point, for two reasons:
 *
 * 1. **It is a claim about the current screen** — "these keys work right now" — so it has
 *    to be computed from explicit facts, not read out of refs that React does not track.
 * 2. The list is part of the product surface (it is how a mouse-first user discovers the
 *    keyboard), so its rules deserve to be stated and tested without rendering Studio.
 *
 * Keys always come from the **live binding table**, via `keyOf`: printing `A` while the
 * user rebound the command to `Ctrl+J` makes the list lie, and a lying shortcut list is
 * worse than none at all.
 */

import type { CommandId } from "./commands.js";

/** One row of the list. */
export interface SpriteShortcut {
  /** Key name to display, e.g. `Ctrl + A`, `Ctrl + Shift + 1`. */
  readonly key: string;
  readonly label: string;
  /** Hover explanation of what this key does right now. */
  readonly detail: string;
}

/**
 * The zoom chord has two meanings by design (it resizes whichever surface owns the input),
 * so it is not one command in the table and cannot be formatted from a binding.
 */
const ZOOM_LABEL = "Ctrl ±";

/** The facts the list depends on. Everything the old `useMemo` read is passed in. */
export interface ShortcutContext {
  /** Whether this layer currently owns the keyboard (`A`). */
  readonly capturing: boolean;
  /** Whether the annotation window is visible (`H`). Independent of activation. */
  readonly surfaceVisible: boolean;
  readonly boardMode: boolean;
  /** Whether Studio has an element selected, so `S` would name it. */
  readonly selectionAvailable: boolean;
  readonly boardHasInk: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Whether at least one mark is still on the frame and can be named. */
  readonly hasLiveMarks: boolean;
  readonly fullscreen: boolean;
}

/**
 * Build the list of shortcuts that work **at this moment**.
 *
 * Read from the live binding table, never from a hard-coded key name.
 */
export function spriteShortcuts(
  context: ShortcutContext,
  keyOf: (id: CommandId) => string,
): SpriteShortcut[] {
  const list: SpriteShortcut[] = [];

  if (!context.capturing) {
    list.push({
      key: keyOf("toggleAnnotate"),
      label: "Start annotating",
      detail:
        "Activates the annotation window and takes over input; Studio underneath stops responding",
    });
    if (context.surfaceVisible) {
      list.push({
        key: keyOf("toggleVisible"),
        label: "Show / hide window",
        detail: "Toggles visibility only — it does not change whether the window is active",
      });
    }
    list.push({ key: ZOOM_LABEL, label: "Zoom interface", detail: zoomDetail() });
    return list;
  }

  list.push({ key: keyOf("toolRegion"), label: "Region", detail: "Drag out a rectangular area on the canvas" });
  list.push({ key: keyOf("toolArrow"), label: "Arrow", detail: "Drag from an element to a target; the element is recorded" });
  list.push({ key: keyOf("toolFreehand"), label: "Freehand", detail: "Draw freely" });
  list.push({
    key: keyOf("toolEraser"),
    label: "Eraser",
    detail: "Click to erase one mark · hold the eraser button to clear every mark at every timecode",
  });
  list.push({ key: keyOf("toolSelect"), label: "Select", detail: "Stop drawing; the canvas ignores the pointer" });

  /*
   * The board is a different surface, so the list says different things there.
   *
   * Claiming "add the newest mark" while a blank page is showing would be a lie: board ink
   * is not a mark and is never delivered. What `S` names there is Studio's selected
   * element, if there is one.
   */
  if (context.boardMode) {
    list.push({
      key: keyOf("addToPrompt"),
      label: "Add to prompt",
      detail: context.selectionAvailable
        ? "Adds the selected element to the prompt"
        : "Select an element in Studio first; a sketch on the board is not delivered",
    });
    if (context.boardHasInk) {
      list.push({
        key: keyOf("undo"),
        label: "Undo on the board",
        detail: "Removes the newest stroke on this page only",
      });
    }
    list.push({
      key: keyOf("toggleBoard"),
      label: "Back to the video",
      detail: "The page keeps its ink; the video keeps its marks",
    });
    list.push({
      key: keyOf("toggleVisible"),
      label: "Show / hide window",
      detail: "Toggles visibility only; the active state is kept",
    });
    list.push({
      key: keyOf("toggleAnnotate"),
      label: "Stop annotating",
      detail: "Toggles activation; Studio underneath starts responding again",
    });
    list.push({ key: ZOOM_LABEL, label: "Zoom interface", detail: zoomDetail() });
    return list;
  }

  list.push(
    context.hasLiveMarks
      ? {
          key: keyOf("addToPrompt"),
          label: "Add to prompt",
          detail: "Appends the newest mark's block reference on a new line",
        }
      : {
          key: keyOf("addToPrompt"),
          label: "Add to prompt",
          detail: "Draw something first, then add it to the prompt",
        },
  );

  if (context.canUndo) {
    list.push({
      key: keyOf("undo"),
      label: "Undo drawing",
      detail: "Removes the newest mark; if it is already in the prompt, its block turns red instead",
    });
  }
  if (context.canRedo) {
    list.push({
      key: keyOf("redo"),
      label: "Redo drawing",
      detail: "Re-applies the last undone drawing action",
    });
  }

  // `E` only works in fullscreen video: there is no room for the Design panel then.
  if (context.fullscreen) {
    list.push({
      key: keyOf("toggleEditor"),
      label: "Properties",
      detail: "Summons the Design panel over the fullscreen video; press again to dismiss",
    });
  }
  list.push({
    key: keyOf("toggleVisible"),
    label: "Show / hide window",
    detail: "Toggles visibility only; the active state is kept",
  });
  list.push({
    key: keyOf("toggleAnnotate"),
    label: "Stop annotating",
    detail: "Toggles activation; Studio underneath starts responding again",
  });
  list.push({
    key: keyOf("toggleBoard"),
    label: "Blank page",
    detail: "Swaps the picture for a blank page of the same size; neither side loses its ink",
  });
  list.push({ key: ZOOM_LABEL, label: "Zoom interface", detail: zoomDetail() });
  return list;
}

function zoomDetail(): string {
  return "Ctrl + plus to zoom in, minus to zoom out, 0 to reset";
}
