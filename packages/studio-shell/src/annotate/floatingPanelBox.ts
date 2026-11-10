/**
 * The clamp rule for a floating panel.
 *
 * Pure and separate from `FloatingPanel.tsx` so the test can call the **real** function.
 * An earlier test re-implemented the same arithmetic next to the component, which meant it
 * kept passing if the component drifted — a test of the copy, not of the product.
 *
 * The rule: a panel must fit entirely when the window is big enough for it, and shrink to
 * fit when it is not. Keeping merely a 120px sliver was harmless while the window could not
 * get small; once it could be 420×340 the prompt box put its send button outside the window.
 */

export interface PanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest size a panel may be squeezed to. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MIN_HEIGHT = 120;

/** Space kept from each window edge, so a panel never loses its grabbable border. */
const OUTER_MARGIN = 8;
const INNER_MARGIN = 16;

/** Clamp a panel into `viewport`, in the same coordinate space as the box. */
export function clampPanelBox(
  box: PanelBox,
  viewport: { readonly width: number; readonly height: number },
): PanelBox {
  const maxW = Math.max(120, viewport.width - INNER_MARGIN);
  const maxH = Math.max(80, viewport.height - INNER_MARGIN);
  const width = Math.max(Math.min(PANEL_MIN_WIDTH, maxW), Math.min(box.width, maxW));
  const height = Math.max(Math.min(PANEL_MIN_HEIGHT, maxH), Math.min(box.height, maxH));
  return {
    width,
    height,
    x: Math.max(OUTER_MARGIN, Math.min(box.x, viewport.width - width - OUTER_MARGIN)),
    y: Math.max(OUTER_MARGIN, Math.min(box.y, viewport.height - height - OUTER_MARGIN)),
  };
}
