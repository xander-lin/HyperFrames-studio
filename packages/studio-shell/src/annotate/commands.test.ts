import { describe, expect, it } from "vitest";
import { COMMANDS, defaultBindings, TOOL_COMMANDS, RESERVED_KEYS } from "./commands.js";
import { bindingKey, isAllowedBinding, matches } from "./keybinding.js";

/**
 * The command registry.
 *
 * These tests are the contract for "what is configurable". They exist because the
 * table is the single source of truth: the dispatcher, the settings screen and the
 * sprite all read it, so a mistake here becomes a mistake everywhere at once.
 */

describe("default bindings", () => {
  it("gives every command a binding", () => {
    const bindings = defaultBindings();
    for (const command of COMMANDS) {
      expect(bindings[command.id], command.id).not.toBeUndefined();
    }
  });

  it("never ships a binding that would steal a typing key", () => {
    /*
     * The requirement that motivated modifiers in the first place: with a bare `s`,
     * typing "s" in any field would add to the prompt. Every default must satisfy the
     * same rule the settings screen enforces.
     */
    for (const command of COMMANDS) {
      const value = command.defaultBinding;
      if (!value) continue;
      expect(isAllowedBinding(value), `${command.id} → ${value.code}`).toBe(true);
    }
  });

  it("gives two commands the same key nowhere", () => {
    // A duplicate default means one of the two actions is unreachable out of the box.
    const seen = new Map<string, string>();
    for (const command of COMMANDS) {
      const value = command.defaultBinding;
      if (!value) continue;
      const key = bindingKey(value);
      expect(seen.get(key), `${command.id} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, command.id);
    }
  });

  it("makes every command configurable except the ones it flags otherwise", () => {
    // Nothing in the table is currently non-configurable; the flag exists so a future
    // command can be added as fixed without changing this test's shape.
    const fixed = COMMANDS.filter((command) => !command.configurable);
    for (const command of fixed) {
      expect(command.defaultBinding, `${command.id} is fixed and must be documented`).toBeNull();
    }
  });
});

describe("what the table describes", () => {
  it("gives every command a label and a hover explanation", () => {
    for (const command of COMMANDS) {
      expect(command.label.length, command.id).toBeGreaterThan(0);
      expect(command.detail.length, command.id).toBeGreaterThan(10);
    }
  });

  it("marks tools and prompt actions as annotation-only", () => {
    // Outside annotation mode these keys must keep their normal meaning.
    expect(COMMANDS.find((c) => c.id === "toolArrow")?.annotationOnly).toBe(true);
    expect(COMMANDS.find((c) => c.id === "addToPrompt")?.annotationOnly).toBe(true);
    expect(COMMANDS.find((c) => c.id === "undo")?.annotationOnly).toBe(true);
    // Activating is precisely the thing that works from outside.
    expect(COMMANDS.find((c) => c.id === "toggleAnnotate")?.annotationOnly).toBe(false);
    expect(COMMANDS.find((c) => c.id === "toggleVisible")?.annotationOnly).toBe(false);
  });
});

describe("tool commands", () => {
  it("maps every tool to exactly one command", () => {
    const ids = Object.values(TOOL_COMMANDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [tool, id] of Object.entries(TOOL_COMMANDS)) {
      expect(COMMANDS.some((command) => command.id === id), tool).toBe(true);
    }
  });

  it("binds each tool to a distinct key", () => {
    const keys = Object.values(TOOL_COMMANDS).map((id) => {
      const command = COMMANDS.find((candidate) => candidate.id === id);
      const value = command?.defaultBinding;
      return value ? `${value.code}` : "";
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("reserved keys", () => {
  it("documents why keys are missing instead of silently omitting them", () => {
    expect(RESERVED_KEYS.length).toBeGreaterThan(0);
    for (const entry of RESERVED_KEYS) {
      expect(entry.keys.length).toBeGreaterThan(0);
      expect(entry.owner.length).toBeGreaterThan(10);
    }
  });

  it("mentions Escape, because that is the first one users ask about", () => {
    expect(RESERVED_KEYS.some((entry) => entry.keys.includes("Escape"))).toBe(true);
  });
});

describe("default matching", () => {
  it("resolves Ctrl+A to toggleAnnotate", () => {
    const value = defaultBindings().toggleAnnotate;
    expect(matches(value, { code: "KeyA", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe(true);
  });

  it("resolves Ctrl+Shift+Z to redo, not undo", () => {
    const bindings = defaultBindings();
    const event = { code: "KeyZ", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(matches(bindings.redo, event)).toBe(true);
    expect(matches(bindings.undo, event)).toBe(false);
  });
});
