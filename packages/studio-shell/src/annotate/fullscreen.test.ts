import { describe, expect, it } from "vitest";
import {
  OVERLAY_HOST_ATTR,
  resolveOverlayHost,
  shouldHandleEditorKey,
  type HostNode,
} from "./fullscreen.js";

/**
 * When `E` applies, and where the overlay is mounted.
 *
 * These must be read together: `E` is taken over only in fullscreen precisely
 * because **fullscreen is when the Design panel has to be lifted out**; and in
 * fullscreen the overlay must live inside the fullscreen element, otherwise the
 * browser will not paint it (only that subtree is painted).
 */

/** A minimal node sufficient for host discovery. */
class FakeNode implements HostNode {
  readonly children: FakeNode[] = [];
  private readonly attrs = new Set<string>();

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, _value = ""): void {
    this.attrs.add(name);
  }

  appendChild(node: FakeNode): FakeNode {
    this.children.push(node);
    return node;
  }
}

function fakeDocument(fullscreenElement: FakeNode | null) {
  const body = new FakeNode();
  return {
    body,
    fullscreenElement,
    createElement: () => new FakeNode(),
    childrenOf: (node: FakeNode) => node.children,
  };
}

describe("shouldHandleEditorKey", () => {
  it("is false when nothing is fullscreen, so Studio keeps the E key", () => {
    // Outside fullscreen the Design panel is already in the layout; we must not take the key.
    expect(shouldHandleEditorKey(null)).toBe(false);
  });

  it("is true whenever something is fullscreen", () => {
    expect(shouldHandleEditorKey({} as unknown as Element)).toBe(true);
  });

  it("depends on the fullscreen fact, not on any width estimate", () => {
    // The earlier rule used "less than 320px free on the right", which misfired in
    // narrow windows that were not fullscreen. The rule now looks only at the fact.
    expect(shouldHandleEditorKey(null)).toBe(false);
    expect(shouldHandleEditorKey({} as unknown as Element)).toBe(true);
  });
});

describe("resolveOverlayHost", () => {
  it("returns document.body when not fullscreen", () => {
    const doc = fakeDocument(null);
    expect(resolveOverlayHost(doc)).toBe(doc.body);
  });

  it("returns a container inside the fullscreen element, where it will actually be painted", () => {
    const fullscreen = new FakeNode();
    const doc = fakeDocument(fullscreen);

    const host = resolveOverlayHost(doc);

    // Critical: it must be a **child** of the fullscreen element or the browser will not paint it.
    expect(fullscreen.children).toContain(host);
    expect(host.hasAttribute(OVERLAY_HOST_ATTR)).toBe(true);
  });

  it("reuses the same container instead of piling up empty nodes", () => {
    const fullscreen = new FakeNode();
    const doc = fakeDocument(fullscreen);

    const first = resolveOverlayHost(doc);
    const second = resolveOverlayHost(doc);

    expect(second).toBe(first);
    expect(fullscreen.children.length).toBe(1);
  });
});
