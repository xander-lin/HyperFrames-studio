/**
 * Toolbar position math.
 *
 * It is its own module because these are **product rules** (how far it can be
 * dragged, when a drag counts, how it is clamped back on screen) worth verifying
 * without React or a DOM. The component only writes the result into styles.
 *
 * Background (found.md F-033): the toolbar once had no drag handle at all — its
 * position was recomputed "against the right edge of the stage" every frame, so
 * every drag was immediately overwritten and it "simply would not move".
 */

export interface DockPosition {
  readonly left: number;
  readonly top: number;
}

/** Toolbar width including padding, used to clamp it inside the viewport. */
export const DOCK_WIDTH = 42;

/**
 * Movement threshold (pixels) that decides "this is a drag, not a click".
 *
 * Every button's pointer event bubbles to the root. Without a threshold, **a
 * single click on a tool icon** starts a drag and nudges the toolbar on release.
 * 4px is the usual "a shaky hand is not a drag" magnitude.
 */
export const DRAG_THRESHOLD = 4;

/** Whether the movement already exceeds the drag threshold. */
export function isBeyondDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

/**
 * Clamp a position into the viewport.
 *
 * The whole toolbar must stay on screen — leaving half of it outside means the
 * user can never click it again. A 4px margin keeps it grabbable.
 */
export function clampDockPosition(
  position: DockPosition,
  height: number,
  viewport: { width: number; height: number },
  /**
   * The toolbar's **current** width, when the caller knows it.
   *
   * The toolbar is not a fixed width: it grows leftwards while the board is showing, since
   * the page list sits beside the board button. Clamping with the collapsed width let the
   * expanded row hang past the window edge, where its buttons were clipped and could not
   * be clicked — a control that renders but cannot be used.
   */
  width: number = DOCK_WIDTH,
): DockPosition {
  const maxLeft = viewport.width - Math.max(width, DOCK_WIDTH) - 4;
  const maxTop = viewport.height - Math.max(height, 40) - 4;
  return {
    // When the viewport is narrower than the toolbar, maxLeft goes negative; fall
    // back to the top-left corner instead of a negative coordinate.
    left: Math.max(4, Math.min(position.left, Math.max(4, maxLeft))),
    top: Math.max(4, Math.min(position.top, Math.max(4, maxTop))),
  };
}

/** New position from a drag delta. */
export function positionAfterDrag(origin: DockPosition, dx: number, dy: number): DockPosition {
  return { left: origin.left + dx, top: origin.top + dy };
}
