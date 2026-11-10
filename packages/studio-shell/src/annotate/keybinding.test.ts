import { describe, expect, it } from "vitest";
import {
  binding,
  bindingFromEvent,
  bindingKey,
  explainRejection,
  formatBinding,
  formatCode,
  isAllowedBinding,
  matches,
  sameBinding,
  type KeyEventLike,
} from "./keybinding.js";

/**
 * Key bindings.
 *
 * The rule being protected is narrow and absolute: **a configurable shortcut must never
 * steal a typing key**. Everything else here follows from it.
 */

function event(over: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over };
}

describe("matches", () => {
  it("requires the code and every modifier to agree", () => {
    const ctrlA = binding("KeyA", { ctrl: true });
    expect(matches(ctrlA, event({ ctrlKey: true }))).toBe(true);
    expect(matches(ctrlA, event())).toBe(false);
  });

  it("does not confuse Ctrl+Z with Ctrl+Shift+Z", () => {
    // Partial matching would make undo and redo indistinguishable.
    const undo = binding("KeyZ", { ctrl: true });
    const redo = binding("KeyZ", { ctrl: true, shift: true });
    expect(matches(undo, event({ code: "KeyZ", ctrlKey: true }))).toBe(true);
    expect(matches(undo, event({ code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matches(redo, event({ code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("never matches an unbound command", () => {
    expect(matches(null, event())).toBe(false);
  });
});

describe("isAllowedBinding", () => {
  it("accepts combinations with a command modifier", () => {
    expect(isAllowedBinding(binding("KeyA", { ctrl: true }))).toBe(true);
    expect(isAllowedBinding(binding("KeyA", { meta: true }))).toBe(true);
    expect(isAllowedBinding(binding("KeyA", { alt: true }))).toBe(true);
  });

  it("accepts a bare function key, because no layout types F5", () => {
    expect(isAllowedBinding(binding("F5"))).toBe(true);
    expect(isAllowedBinding(binding("F12"))).toBe(true);
  });

  it("refuses a bare letter or digit", () => {
    /*
     * The whole reason the table requires Ctrl: `s` must produce "s" in a text field,
     * and the number row must produce digits. Binding either to an action creates a
     * conflict that fires the moment focus is not where the user thinks.
     */
    expect(isAllowedBinding(binding("KeyS"))).toBe(false);
    expect(isAllowedBinding(binding("Digit1"))).toBe(false);
    expect(isAllowedBinding(binding("Space"))).toBe(false);
  });

  it("refuses Shift alone, because Shift+7 is still a character", () => {
    expect(isAllowedBinding(binding("Digit7", { shift: true }))).toBe(false);
  });

  it("refuses Escape even with a modifier", () => {
    // The safety valve must stay reachable in one press.
    expect(isAllowedBinding(binding("Escape", { ctrl: true }))).toBe(false);
    expect(isAllowedBinding(binding("Escape"))).toBe(false);
  });

  it("refuses a bare modifier key", () => {
    expect(isAllowedBinding(binding("ShiftLeft"))).toBe(false);
    expect(isAllowedBinding(binding("ControlRight"))).toBe(false);
  });
});

describe("explainRejection", () => {
  it("says why a typing key is refused, in terms of the consequence", () => {
    const reason = explainRejection(binding("KeyS"));
    expect(reason).toContain("Ctrl");
    expect(reason).toContain("typing");
  });

  it("explains the Escape reservation", () => {
    expect(explainRejection(binding("Escape"))).toContain("Escape");
  });

  it("returns null for an acceptable binding", () => {
    expect(explainRejection(binding("KeyA", { ctrl: true }))).toBeNull();
  });
});

describe("formatting", () => {
  it("prints a combination the way it is spoken", () => {
    expect(formatBinding(binding("KeyZ", { ctrl: true, shift: true }))).toBe("Ctrl + Shift + Z");
    expect(formatBinding(binding("Digit1", { ctrl: true }))).toBe("Ctrl + 1");
    expect(formatBinding(binding("F5"))).toBe("F5");
  });

  it("says Unassigned rather than printing nothing", () => {
    // An empty cell in the settings table would look like a rendering bug.
    expect(formatBinding(null)).toBe("Unassigned");
  });

  it("prints physical key codes as key labels", () => {
    expect(formatCode("KeyA")).toBe("A");
    expect(formatCode("Digit7")).toBe("7");
    expect(formatCode("Space")).toBe("Space");
    expect(formatCode("BracketLeft")).toBe("[");
  });
});

describe("bindingKey / sameBinding", () => {
  it("treats the same combination as equal regardless of construction order", () => {
    expect(sameBinding(binding("KeyZ", { ctrl: true, shift: true }), binding("KeyZ", { shift: true, ctrl: true }))).toBe(true);
  });

  it("distinguishes different modifiers", () => {
    expect(sameBinding(binding("KeyZ", { ctrl: true }), binding("KeyZ", { meta: true }))).toBe(false);
  });

  it("treats unbound as equal only to unbound", () => {
    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(null, binding("KeyA", { ctrl: true }))).toBe(false);
  });

  it("produces a stable key for a combination", () => {
    expect(bindingKey(binding("KeyZ", { ctrl: true, shift: true }))).toBe("C+S+KeyZ");
  });
});

describe("bindingFromEvent", () => {
  it("captures modifiers exactly as the event reported them", () => {
    const captured = bindingFromEvent(
      event({ code: "KeyJ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
    );
    expect(captured).toEqual({ code: "KeyJ", ctrl: true, shift: false, alt: false, meta: false });
  });
});
