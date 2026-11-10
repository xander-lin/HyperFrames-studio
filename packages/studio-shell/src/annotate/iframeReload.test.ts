import { describe, expect, it } from "vitest";
import { subscribeIframeReload, type FrameLike } from "./iframeReload.js";

/**
 * Re-installing the policy when the preview navigates.
 *
 * Studio keeps one `<iframe>` element and navigates it, so element identity says nothing
 * about which document is showing. A listener attached to the old `contentWindow` dies with
 * that window; Studio re-attaches its own hotkeys on `load`, so if this layer did not, the
 * preview became a place where Studio's single-letter keys worked again while the layer was
 * supposedly in charge (found.md F-089).
 */

/** A frame whose document can be replaced, as a real navigation would. */
function fakeFrame() {
  const listeners = new Set<() => void>();
  const docListeners = new Set<() => void>();
  let doc: { addEventListener: (t: string, h: () => void) => void; removeEventListener: (t: string, h: () => void) => void } | null =
    {
      addEventListener: (type, handler) => {
        if (type === "readystatechange") docListeners.add(handler);
      },
      removeEventListener: (type, handler) => {
        if (type === "readystatechange") docListeners.delete(handler);
      },
    };

  const frame = {
    addEventListener: (type: "load", handler: () => void) => {
      if (type === "load") listeners.add(handler);
    },
    removeEventListener: (type: "load", handler: () => void) => {
      if (type === "load") listeners.delete(handler);
    },
    get contentDocument() {
      return doc;
    },
  };

  return {
    frame: frame as unknown as FrameLike,
    /** Simulate navigation: fire `load`, and install a fresh document. */
    reload() {
      for (const handler of [...listeners]) handler();
    },
    fireDocReady() {
      for (const handler of [...docListeners]) handler();
    },
    get loadListenerCount() {
      return listeners.size;
    },
    get docListenerCount() {
      return docListeners.size;
    },
    /** A detached frame: `contentDocument` throws, as it does cross-origin. */
    breakDocument() {
      doc = null;
    },
  };
}

describe("subscribeIframeReload", () => {
  it("fires once per navigation", () => {
    const fake = fakeFrame();
    let reloads = 0;
    subscribeIframeReload(fake.frame, () => {
      reloads += 1;
    });

    fake.reload();
    fake.reload();

    expect(reloads).toBe(2);
  });

  it("does nothing for a missing frame", () => {
    // The preview may not be mounted yet; that is not an error.
    expect(() => subscribeIframeReload(null, () => {})()).not.toThrow();
  });

  it("unsubscribes both the element and the document", () => {
    const fake = fakeFrame();
    let reloads = 0;
    const unsubscribe = subscribeIframeReload(fake.frame, () => {
      reloads += 1;
    });
    expect(fake.loadListenerCount).toBe(1);

    unsubscribe();

    expect(fake.loadListenerCount).toBe(0);
    fake.reload();
    expect(reloads).toBe(0);
  });

  it("survives a frame whose document is unavailable", () => {
    // Cross-origin preview: there is nothing to annotate either, so this is graceful.
    const fake = fakeFrame();
    fake.breakDocument();
    expect(() => subscribeIframeReload(fake.frame, () => {})()).not.toThrow();
  });
});
