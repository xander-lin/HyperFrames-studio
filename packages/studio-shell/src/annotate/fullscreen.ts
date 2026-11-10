/**
 * Fullscreen state and the overlay host.
 *
 * Two problems must be solved together here:
 *
 * 1. **When `E` applies.** The rule is "take over `E` only while the video is
 *    actually fullscreen" — outside fullscreen the Design panel is already part of
 *    the layout, so `E` belongs to Studio. (An earlier heuristic used "less than
 *    320px free on the right", which is only an approximation: a narrow window that
 *    is not fullscreen would be misjudged as "take over"; see found.md F-030.)
 *
 * 2. **Why overlays become invisible in fullscreen.** After entering fullscreen
 *    the browser **paints only the fullscreen element's subtree**; other nodes on
 *    `document.body` are not painted. The annotation layer used to live on `body`,
 *    so in fullscreen the DOM was there, React rendered fine, and nothing appeared.
 *
 * Remedy: mount the overlay into a dedicated container inside the fullscreen
 * element, and return to `body` on exit.
 *
 * To keep these decisions testable without a DOM, the functions depend on a tiny
 * structural interface (`OverlayDocument`) instead of referencing `document`
 * directly.
 */

import { useMemo, useSyncExternalStore } from "react";

/** Marker attribute on the overlay container, so it is reused rather than recreated. */
export const OVERLAY_HOST_ATTR = "data-mystudio-overlay-host";

/**
 * Minimum capability a mount point needs: hold children, read a marker attribute.
 *
 * `appendChild` takes `object` rather than `HostNode` so both a real `Element` and the
 * test's minimal node satisfy the interface without a cast. The real DOM's generic
 * `appendChild<T extends Node>` is compatible because `Node` is an `object`.
 */
export interface HostNode {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  appendChild(node: object): unknown;
}

/**
 * Everything needed to mount an overlay. Only the used subset is declared.
 *
 * `childrenOf` exists so the node returned from the scan has the document's own node
 * type. Without it the interface would have to claim every child is a `HostNode`, and
 * the caller would need a cast to get a real `Element` back.
 */
export interface OverlayDocument<T extends HostNode> {
  readonly body: T;
  readonly fullscreenElement: T | null;
  createElement(tagName: "div"): T;
  childrenOf(node: T): ArrayLike<T>;
}

export function subscribeFullscreen(callback: () => void): () => void {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
}

export function getFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  return document.fullscreenElement ?? null;
}

/**
 * Whether `E` should be handled by us.
 *
 * Only when **genuinely fullscreen**. The fullscreen element is the source of
 * truth; estimating how wide the stage looks misjudges narrow windows.
 */
export function shouldHandleEditorKey(fullscreenElement: Element | null): boolean {
  return fullscreenElement !== null;
}

/**
 * Where the overlay should be mounted.
 *
 * - Not fullscreen: `document.body` (a normal portal).
 * - Fullscreen: a dedicated container **inside** the fullscreen element, because
 *   only descendants get painted.
 *
 * The container is reused, so toggling fullscreen does not pile up empty divs.
 */
export function resolveOverlayHost<T extends HostNode>(doc: OverlayDocument<T>): T {
  const fullscreen = doc.fullscreenElement;
  if (!fullscreen) return doc.body;

  for (const child of Array.from(doc.childrenOf(fullscreen))) {
    if (child.hasAttribute(OVERLAY_HOST_ATTR)) return child;
  }

  const host = doc.createElement("div");
  // The marker is how the container is recognised next time and reused.
  host.setAttribute(OVERLAY_HOST_ATTR, "");
  fullscreen.appendChild(host);
  return host;
}

/** The current fullscreen element; updates on `fullscreenchange`. */
export function useFullscreenElement(): Element | null {
  return useSyncExternalStore(
    subscribeFullscreen,
    getFullscreenElement,
    // There is no fullscreen concept during server rendering.
    () => null,
  );
}

/** Overlay host node: a container inside the fullscreen element, otherwise `document.body`. */
export function useOverlayHost(): Element {
  const fullscreen = useFullscreenElement();
  // Depend on fullscreen, not on a per-render value: the container switches when
  // entering/leaving fullscreen. `Element` is the type `createPortal` accepts, and the
  // generic call lets the real DOM types satisfy `HostNode` without an assertion.
  return useMemo(
    () =>
      resolveOverlayHost<Element>({
        body: document.body,
        fullscreenElement: document.fullscreenElement,
        createElement: () => document.createElement("div"),
        childrenOf: (node) => node.children,
      }),
    [fullscreen],
  );
}
