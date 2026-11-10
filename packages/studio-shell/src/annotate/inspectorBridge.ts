/**
 * Move Studio's own Design (Inspector) panel into the editor float.
 *
 * Why not reimplement a property panel: `PropertyPanel` takes 60+ props covering
 * styles, the GSAP timeline, text boxes, colour grading, group editing… rewriting
 * it means copying upstream and never catching up.
 *
 * So the panel is **moved, not duplicated**:
 * 1. find the group that hosts the Design tab and compute its on-screen rect;
 * 2. identify the content node occupying that rect inside dockview's render layer;
 * 3. move that node into the float; move it back when the float closes.
 *
 * **The key trap (found.md F-031):** dockview 8 puts panel content into
 * absolutely-positioned `.dv-render-overlay` layers, **not** into the
 * `#dv-tabpanel-N` element referenced by `aria-controls`. That container is always
 * empty — following it yields an empty float. This module therefore locates the
 * real content node by geometry instead of trusting `aria-controls`.
 *
 * Risks and mitigations: dockview may rebuild nodes on layout changes, so every
 * open re-resolves instead of caching DOM references, and restoring checks that the
 * original parent still exists.
 */

/** Record of a moved panel, used to restore it. */
interface Stash {
  readonly node: HTMLElement;
  readonly originalParent: HTMLElement;
  readonly originalNextSibling: Node | null;
  /** Inline styles before the move, written back one by one on restore. */
  readonly originalStyle: {
    height: string;
    width: string;
    position: string;
    left: string;
    top: string;
    transform: string;
  };
}

let stash: Stash | null = null;

/** Find the Design tab element. */
function findDesignTab(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-tab-panel-id]")].find(
      (element) => element.getAttribute("data-tab-panel-id") === "design",
    ) ?? null
  );
}

/** Whether the Design tab is currently selected (foreground). */
export function isDesignPanelSelected(): boolean {
  const tab = findDesignTab();
  if (!tab) return false;
  const role = tab.closest<HTMLElement>("[role=tab]") ?? tab;
  return role.getAttribute("aria-selected") === "true";
}

/**
 * Find the Design panel's real content node.
 *
 * Geometry matching: take the rect of the group holding the Design tab, then pick
 * the render-overlay rect fully inside it. More reliable than `aria-controls`,
 * whose target holds nothing at all.
 */
export function findDesignPanel(): HTMLElement | null {
  const tab = findDesignTab();
  if (!tab) return null;

  const group = tab.closest<HTMLElement>(".dv-groupview") ?? tab.parentElement;
  if (!group) return null;
  const bounds = group.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  let best: { node: HTMLElement; area: number } | null = null;
  for (const overlay of document.querySelectorAll<HTMLElement>(".dv-render-overlay")) {
    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // The overlay must sit inside this group (2px tolerance for rounded borders).
    const inside =
      rect.left >= bounds.left - 2 &&
      rect.top >= bounds.top - 2 &&
      rect.right <= bounds.right + 2 &&
      rect.bottom <= bounds.bottom + 2;
    if (!inside) continue;

    // Only take it if it actually has content: moving an empty shell yields a blank float.
    const content = overlay.querySelector<HTMLElement>(".dv-react-part") ?? overlay;
    if (content.childElementCount === 0 && (content.textContent ?? "").trim() === "") continue;

    const area = rect.width * rect.height;
    if (!best || area > best.area) best = { node: overlay, area };
  }

  return best?.node ?? null;
}

/**
 * Move the Design panel into `host`.
 *
 * Returns false when there is nothing to move (tab not selected, panel not
 * rendered, …); the caller should report why rather than show an empty float.
 */
export function borrowDesignPanel(host: HTMLElement): boolean {
  // Already lent out: if it is still in the host, do not move it again.
  if (stash) {
    if (stash.node.isConnected && stash.node.parentElement === host) return true;
    restoreDesignPanel();
  }

  // An unselected tab renders no content, so borrowing gives a bare shell. Make
  // the caller activate it first.
  if (!isDesignPanelSelected()) return false;

  const panel = findDesignPanel();
  if (!panel) return false;

  const originalParent = panel.parentElement;
  if (!originalParent) return false;

  stash = {
    node: panel,
    originalParent,
    originalNextSibling: panel.nextSibling,
    originalStyle: {
      height: panel.style.height,
      width: panel.style.width,
      position: panel.style.position,
      left: panel.style.left,
      top: panel.style.top,
      transform: panel.style.transform,
    },
  };

  /*
   * The overlay is absolutely positioned and carries **screen coordinates dockview
   * computed** (`left: 1489px; top: 40px`). Dropped into a normal flow container,
   * those leftover coordinates push the content off-screen — the float looks empty
   * while the content is far away.
   *
   * So three things happen together: switch back to relative positioning, clear
   * the leftovers, and fill the host. The content itself is responsive and follows
   * the float's size.
   */
  panel.style.position = "relative";
  panel.style.left = "0";
  panel.style.top = "0";
  panel.style.transform = "none";
  panel.style.height = "100%";
  panel.style.width = "100%";
  host.appendChild(panel);
  return true;
}

/** Move the panel back. Idempotent. */
export function restoreDesignPanel(): void {
  if (!stash) return;
  const { node, originalParent, originalNextSibling, originalStyle } = stash;
  stash = null;

  node.style.height = originalStyle.height;
  node.style.width = originalStyle.width;
  node.style.position = originalStyle.position;
  node.style.left = originalStyle.left;
  node.style.top = originalStyle.top;
  node.style.transform = originalStyle.transform;

  // The original parent may have been destroyed by a layout change; do not stuff
  // the node into a detached tree.
  if (!originalParent.isConnected) return;

  if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
    originalParent.insertBefore(node, originalNextSibling);
  } else {
    originalParent.appendChild(node);
  }
}

/** Whether the panel is currently lent out; for tests and debugging. */
export function isPanelBorrowed(): boolean {
  return stash !== null;
}
