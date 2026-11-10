import { describe, expect, it } from "vitest";
import { releaseFieldFocus } from "./focusRelease.js";

/**
 * Taking the caret out of a text field on a pointer action.
 *
 * The reported defect: draw on the canvas and the caret stayed in the prompt box, so
 * `Ctrl+Z` still addressed the text and the box kept looking active while the pointer was
 * on the picture (found.md F-102).
 */

/** Minimal stand-in for the bits of `document` this function touches. */
function fakeDocument(active: unknown): { readonly activeElement: unknown } {
  return { activeElement: active };
}

function withDocument(active: unknown, run: () => void): void {
  const previous = (globalThis as { document?: unknown }).document;
  Object.defineProperty(globalThis, "document", {
    value: fakeDocument(active),
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "document", {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

describe("releaseFieldFocus", () => {
  it("blurs a focused contenteditable", () => {
    let blurred = 0;
    const box = {
      isContentEditable: true,
      tagName: "DIV",
      blur: () => {
        blurred += 1;
      },
    };
    withDocument(box, () => releaseFieldFocus());
    expect(blurred).toBe(1);
  });

  it("blurs a focused input or textarea", () => {
    for (const tagName of ["INPUT", "TEXTAREA"]) {
      let blurred = 0;
      const field = { isContentEditable: false, tagName, blur: () => (blurred += 1) };
      withDocument(field, () => releaseFieldFocus());
      expect(blurred, tagName).toBe(1);
    }
  });

  it("leaves anything else alone", () => {
    // A button or the body must not be blurred by drawing on the picture.
    let blurred = 0;
    const button = { isContentEditable: false, tagName: "BUTTON", blur: () => (blurred += 1) };
    withDocument(button, () => releaseFieldFocus());
    expect(blurred).toBe(0);
  });

  it("does nothing when nothing is focused", () => {
    withDocument(null, () => expect(() => releaseFieldFocus()).not.toThrow());
  });

  it("does not throw for a node that refuses to blur", () => {
    // A node mid-teardown can throw; that must not interrupt a drawing gesture.
    const box = {
      isContentEditable: true,
      tagName: "DIV",
      blur: () => {
        throw new Error("detached");
      },
    };
    withDocument(box, () => expect(() => releaseFieldFocus()).not.toThrow());
  });
});
