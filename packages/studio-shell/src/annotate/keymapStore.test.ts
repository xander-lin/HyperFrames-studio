import { describe, expect, it } from "vitest";
import { binding } from "./keybinding.js";
import { findConflict, resolveKeymap } from "./keymapStore.js";
import type { CommandId } from "./commands.js";

/**
 * Keymap storage.
 *
 * `resolveKeymap` is the trust boundary: everything it returns is used to route
 * keystrokes, and its input can be a hand-edited file or leftovers from an older
 * version. These tests feed it things the UI would never produce, on purpose.
 */

function file(overrides: Record<string, unknown>) {
  return { version: 1, overrides };
}

describe("resolveKeymap — the trust boundary", () => {
  it("falls back to defaults for an empty or missing file", () => {
    for (const raw of [null, undefined, {}, { version: 2, overrides: {} }, "nonsense", 42]) {
      const resolved = resolveKeymap(raw);
      expect(resolved.bindings.toggleAnnotate).not.toBeNull();
      expect(resolved.rejected).toEqual([]);
    }
  });

  it("applies an override without touching anything else", () => {
    const resolved = resolveKeymap(file({ toggleAnnotate: binding("KeyJ", { ctrl: true }) }));
    expect(resolved.bindings.toggleAnnotate).toEqual(binding("KeyJ", { ctrl: true }));
    // Untouched commands keep following the defaults.
    expect(resolved.bindings.toggleVisible).toEqual(binding("KeyH", { ctrl: true }));
  });

  it("refuses an override that would steal a typing key", () => {
    /*
     * The UI refuses this too, but a hand-edited file is not the UI. If the file were
     * trusted, typing "s" in a field would append to the prompt — the exact bug the
     * modifier requirement exists to prevent.
     */
    const resolved = resolveKeymap(file({ addToPrompt: binding("KeyS") }));
    expect(resolved.bindings.addToPrompt).toEqual(binding("KeyS", { ctrl: true }));
    expect(resolved.rejected).toHaveLength(1);
    expect(resolved.rejected[0]?.reason).toContain("Ctrl");
  });

  it("refuses an override for an unknown command instead of crashing", () => {
    const resolved = resolveKeymap(file({ somethingRemoved: binding("KeyQ", { ctrl: true }) }));
    expect(resolved.rejected[0]?.reason).toContain("Unknown");
  });

  it("accepts null as a deliberate unbinding", () => {
    const resolved = resolveKeymap(file({ toggleVisible: null }));
    expect(resolved.bindings.toggleVisible).toBeNull();
    expect(resolved.rejected).toEqual([]);
  });

  it("keeps the first owner of a duplicated key and moves the loser back to its default", () => {
    /*
     * Two commands on one key means one of them is unreachable, and the user cannot
     * discover that except by pressing the key and watching the wrong thing happen.
     * "First wins" is arbitrary but definite, and definite is what matters.
     */
    const resolved = resolveKeymap(file({ toggleVisible: binding("KeyA", { ctrl: true }) }));
    // `toggleAnnotate` comes first in the table and keeps Ctrl+A.
    expect(resolved.bindings.toggleAnnotate).toEqual(binding("KeyA", { ctrl: true }));
    // The loser goes back to its own default rather than to nothing.
    expect(resolved.bindings.toggleVisible).toEqual(binding("KeyH", { ctrl: true }));
    expect(resolved.rejected.some((entry) => entry.id === "toggleVisible")).toBe(true);
  });

  it("never leaves a rejected override in the reported overrides", () => {
    // Otherwise the bad value would be written back on the next save and live forever.
    const resolved = resolveKeymap(file({ addToPrompt: binding("KeyS") }));
    expect(resolved.overrides.addToPrompt).toBeUndefined();
  });
});

describe("findConflict", () => {
  const bindings = resolveKeymap(null).bindings;

  it("reports the command already using a combination", () => {
    // Ctrl+E is toggleEditor; asking to put toggleVisible there names the owner.
    expect(findConflict(bindings, "toggleVisible", binding("KeyE", { ctrl: true }))).toBe(
      "toggleEditor",
    );
  });

  it("does not report a command as conflicting with itself", () => {
    // Re-recording the same key for the same command is a no-op, not a conflict.
    expect(findConflict(bindings, "toggleEditor", binding("KeyE", { ctrl: true }))).toBeNull();
  });

  it("allows an unused combination", () => {
    expect(findConflict(bindings, "toggleVisible", binding("KeyJ", { ctrl: true }))).toBeNull();
  });

  it("treats unbinding as never conflicting", () => {
    expect(findConflict(bindings, "toggleVisible", null)).toBeNull();
  });
});

describe("every configurable command is reachable through the resolver", () => {
  it("round-trips a full set of overrides", () => {
    const overrides: Partial<Record<CommandId, unknown>> = {
      toggleAnnotate: binding("Key1", { ctrl: true, alt: true }),
      toggleVisible: binding("Key2", { ctrl: true, alt: true }),
      undo: binding("F1"),
      redo: binding("F2"),
    };
    const resolved = resolveKeymap(file(overrides as Record<string, unknown>));
    expect(resolved.rejected).toEqual([]);
    expect(resolved.bindings.toggleAnnotate).toEqual(binding("Key1", { ctrl: true, alt: true }));
    expect(resolved.bindings.undo).toEqual(binding("F1"));
  });
});
