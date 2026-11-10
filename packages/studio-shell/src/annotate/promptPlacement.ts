/**
 * Placement for the floating prompt box and the default toolbar position.
 *
 * Pure arithmetic, deliberately separate from `mount.tsx`: "where does this panel go" is
 * a product rule with edge cases (a wide window, a narrow one, a zoomed layer), and it
 * should be verifiable without rendering anything.
 *
 * ## Everything here is in **layer** coordinates
 *
 * The overlay is rendered inside a container scaled with `transform: scale()`. Children
 * lay themselves out in unscaled units, and `stageRect` is divided by the scale before it
 * gets here. The viewport therefore has to be divided too — passing `window.innerWidth`
 * would tell a 200%-zoomed layer that it has twice the room it actually has, and the
 * prompt box would be placed outside the window and then clamped back over the picture.
 */

/** The picture's rect, in whatever coordinate space the caller is laying out in. */
export interface StageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
}

/** Toolbar width reserved when a panel has to clear it (the collapsed toolbar is ~38px). */
export const DOCK_CLEARANCE = 52;

/** Space the prompt box keeps from the window edge. */
const EDGE_MARGIN = 16;

/**
 * Default placement for the prompt box: **the empty space to the right of the picture**.
 *
 * "Use the blank layout" is explicit: when the window is wider than the picture, the free
 * area on the right is where the box belongs. Without that room it retreats to the
 * lower-right *inside* the picture — lower-right because the player's own controls sit
 * upper-right, and covering them would block them.
 *
 * The picture is never squeezed to make space; the user can always drag the box away.
 */
export function promptPlacement(
  stage: StageRect | null,
  viewportWidth: number,
): Placement {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 1280;

  // Before the picture has been measured, park it on the right so it does not cover the
  // asset panel on the left.
  if (!stage) {
    return { position: { x: Math.max(EDGE_MARGIN, viewport - 336), y: 96 }, width: 300 };
  }

  const freeSpace = viewport - (stage.left + stage.width) - DOCK_CLEARANCE - EDGE_MARGIN;
  if (freeSpace >= 240) {
    return {
      position: {
        x: Math.round(stage.left + stage.width + DOCK_CLEARANCE),
        y: Math.round(Math.max(64, stage.top)),
      },
      width: Math.min(340, freeSpace),
    };
  }

  const safeWidth = Math.max(260, Math.min(320, freeSpace));
  return {
    position: {
      x: Math.round(stage.left + stage.width - safeWidth - 12),
      y: Math.round(stage.top + stage.height - 250),
    },
    width: safeWidth,
  };
}

/**
 * Default toolbar position: hug the right edge of the picture, vertically centred.
 *
 * This is only the **default**. Once the user drags the toolbar, `AnnotationDock` keeps
 * their placement and never looks here again.
 *
 * The toolbar grows **leftwards** when the board is showing (the page panel appears beside
 * the board button), so its left edge is a property of the collapsed state and the expanded
 * row never pushes it past the window edge.
 */
export function dockDefaultPosition(
  stage: StageRect | null,
  viewport: { readonly width: number; readonly height: number },
  reservedWidth = DOCK_CLEARANCE,
): { readonly left: number; readonly top: number } {
  if (!stage) {
    return {
      left: Math.round(viewport.width - reservedWidth - 6),
      top: Math.round(viewport.height / 2 - 90),
    };
  }
  return {
    left: Math.round(stage.left + stage.width + 6),
    top: Math.round(stage.top + stage.height / 2 - 90),
  };
}
