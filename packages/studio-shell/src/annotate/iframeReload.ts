/**
 * When the preview's **document** changes under the same iframe element.
 *
 * ## Why this is not "when the iframe changes"
 *
 * Studio keeps one `<iframe>` element and **navigates** it: switching composition, a soft
 * reload, a re-render all replace the inner window while the element stays put. Listeners
 * attached to `iframe.contentWindow` die with that window, and the element identity says
 * nothing about it.
 *
 * Studio's own hotkeys re-attach on `load` for exactly this reason. This layer attached
 * once per **element**, so after any navigation its capture listener was gone from the
 * iframe while Studio's was restored — and single-letter keys started reaching playback
 * again (found.md F-089).
 *
 * So the module exposes `load` plus the document's own lifecycle as one subscription, and
 * the caller re-installs the policy on each of them.
 */

export interface FrameLike {
  addEventListener(type: "load", listener: () => void): void;
  removeEventListener(type: "load", listener: () => void): void;
}

/**
 * Call `onReload` whenever this iframe gets a new document.
 *
 * Listens for:
 * - `load` — the ordinary navigation/reload path;
 * - `readystatechange` on the inner document, which also fires for a same-document
 *   replacement that does not emit `load` on the element.
 *
 * Returns an unsubscribe function. Never throws for a cross-origin or detached frame: the
 * worst case is that we simply keep the top-level listener, which is still correct.
 */
export function subscribeIframeReload(
  iframe: FrameLike | null,
  onReload: () => void,
): () => void {
  if (!iframe) return () => {};

  const cleanups: Array<() => void> = [];
  const handleLoad = () => {
    onReload();
    // The new document starts in `loading`; attaching after `load` misses the readiness
    // transition, so also cover the case where it is still loading now.
    attachDocumentReload();
  };

  const attachDocumentReload = (): void => {
    let doc: Document | null = null;
    try {
      doc = (iframe as unknown as { contentDocument: Document | null }).contentDocument;
    } catch {
      // Cross-origin: nothing we can observe, and nothing we could annotate either.
      return;
    }
    if (!doc) return;
    const handleReady = () => onReload();
    doc.addEventListener("readystatechange", handleReady);
    cleanups.push(() => doc?.removeEventListener("readystatechange", handleReady));
  };

  try {
    iframe.addEventListener("load", handleLoad);
    cleanups.push(() => iframe.removeEventListener("load", handleLoad));
  } catch {
    // Detached frame: the caller keeps whatever it had.
  }
  attachDocumentReload();

  return () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // A dead window cannot be cleaned up; nothing to do.
      }
    }
  };
}
