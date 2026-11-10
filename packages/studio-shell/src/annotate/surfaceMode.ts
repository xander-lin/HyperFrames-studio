/**
 * The annotation window state.
 *
 * There are three **independent** axes here and they must not be collapsed into a
 * single enum:
 *
 * | axis      | shortcut | meaning |
 * |-----------|----------|---------|
 * | `visible` | `H`      | whether the window is on screen. **Affects visibility only**, not input or activation. |
 * | `active`  | `A`      | whether it **captures input**. While active, Studio underneath stops responding. |
 * | position  | drag     | while inactive the window stays visible and can be moved, but swallows all other input to avoid accidents. |
 *
 * Why they must stay separate — collapsing them produces these broken behaviours:
 * - "hiding deactivates" → after H then H again the user finds the state lost;
 * - "inactive means hidden" → the user cannot park the window on the canvas as a
 *   reference.
 *
 * Deliberately React-free so it can be tested on its own.
 */

export interface SurfaceState {
  /** Whether the window renders. Toggled by H. */
  readonly visible: boolean;
  /**
   * Whether input is captured. Toggled by A.
   *
   * Active: our canvas takes the pointer, a full-viewport shield blocks what is
   * underneath, and the keyboard only runs our shortcuts.
   * Inactive: the window is still visible and draggable, but its controls accept
   * no clicks.
   */
  readonly active: boolean;
  /** The property float (E). Only meaningful while active. */
  readonly editorOpen: boolean;
  /** Element identifier the property float points at. */
  readonly editorTarget: string | null;
}

/**
 * Initial state: **visible but inactive**.
 *
 * Not hidden, because someone opening the app for the first time has no idea they
 * should press A — the window has to be there. While inactive it occupies a small
 * area, only moves, and accepts no input, so it does not get in the way.
 */
export const INITIAL_SURFACE: SurfaceState = {
  visible: true,
  active: false,
  editorOpen: false,
  editorTarget: null,
};

/**
 * `H`: toggle visibility only.
 *
 * Deliberately leaves `active` untouched: H is not about input or activation.
 * While hidden the window does not render, hence captures nothing; pressing H
 * again restores the exact previous state.
 */
export function toggleVisible(state: SurfaceState): SurfaceState {
  return { ...state, visible: !state.visible };
}

/**
 * `A`: toggle activation.
 *
 * Activating implies visible — an invisible thing cannot be active. Deactivating
 * also closes the property float: the float is part of interaction, and leaving it
 * behind would strand an orphan window.
 */
export function toggleActive(state: SurfaceState): SurfaceState {
  if (state.active) {
    return { ...state, active: false, editorOpen: false };
  }
  return { ...state, visible: true, active: true };
}

/** `E`: the property float. Only while active — an inactive window takes no input at all. */
export function toggleEditor(state: SurfaceState): SurfaceState {
  if (!state.active) return state;
  return { ...state, editorOpen: !state.editorOpen };
}

/** Sync the selected element into the float. */
export function setEditorTarget(state: SurfaceState, target: string | null): SurfaceState {
  if (state.editorTarget === target) return state;
  return { ...state, editorTarget: target };
}

/**
 * Whether input should currently be captured.
 *
 * Only "visible and active" — while hidden nothing renders, so nothing should
 * capture.
 */
export function capturesInput(state: SurfaceState): boolean {
  return state.visible && state.active;
}
