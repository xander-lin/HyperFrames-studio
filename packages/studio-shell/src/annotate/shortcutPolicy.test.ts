import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOUSE_ONLY_POLICY,
  PERMISSIVE_POLICY,
  installShortcutPolicy,
  installShortcutPolicyOnFrame,
  resetShortcutDedupe,
  yieldsToTextEditing,
  type ShortcutHandlers,
} from "./shortcutPolicy.js";
import { COMMANDS, defaultBindings, type CommandId } from "./commands.js";
import { binding, matches, type Binding, type KeyEventLike } from "./keybinding.js";

/**
 * Keyboard routing.
 *
 * The policy no longer knows *which* key does what — that is the user-configurable
 * table in `commands.ts`. What it owns is the routing rules, and those are what this
 * file pins down:
 *
 * 1. a command fires **before** the typing check, so `Ctrl+S` works while the caret is
 *    in the prompt box;
 * 2. a plain letter is never a command, so typing is never stolen;
 * 3. an unhandled command falls through untouched instead of being swallowed.
 */

let eventClock = 0;

beforeEach(() => {
  resetShortcutDedupe();
  eventClock = 0;
});

type Handler = (event: unknown) => void;

function fakeTarget() {
  const listeners = new Map<string, Handler[]>();
  return {
    listeners,
    addEventListener: (type: string, handler: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: Handler) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((h) => h !== handler),
      );
    },
    fire(type: string, event: unknown, path: unknown[] = []) {
      if (typeof event === "object" && event !== null) {
        (event as { type?: string }).type = type;
      }
      if (path.length > 0 && typeof event === "object" && event !== null) {
        (event as { composedPath?: () => unknown[] }).composedPath = () => path;
      }
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
}

interface FakeEvent {
  type: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  timeStamp: number;
  composedPath: () => unknown[];
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
}

function keyEvent(
  code: string,
  options: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
    path?: unknown[];
    repeat?: boolean;
    timeStamp?: number;
    type?: string;
  } = {},
): FakeEvent {
  eventClock += 1;
  return {
    type: options.type ?? "keydown",
    code,
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    altKey: options.alt ?? false,
    shiftKey: options.shift ?? false,
    repeat: options.repeat ?? false,
    timeStamp: options.timeStamp ?? eventClock * 1_000,
    composedPath: () => options.path ?? [],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
}

/** A dispatcher built from the real default table, so tests exercise production bindings. */
/**
 * A policy with the annotation layer **inactive** by default.
 *
 * `annotating` is a parameter rather than always `true`: the ownership rule is different in
 * each state, and a fixture that hard-codes the active state cannot express the inactive
 * half at all — which is how "`A` still reaches the preview" survived testing.
 */
function dispatcher(
  overrides: Partial<Record<CommandId, Binding>> = {},
  options: { readonly annotating?: boolean } = {},
) {
  const bindings: Record<CommandId, Binding> = { ...defaultBindings(), ...overrides };
  const calls: CommandId[] = [];
  let annotating = options.annotating ?? false;

  const handlers: ShortcutHandlers = {
    commandFor: (event: KeyEventLike) => {
      for (const command of COMMANDS) {
        if (matches(bindings[command.id], event)) return command.id;
      }
      return null;
    },
    runCommand: (id) => {
      calls.push(id);
      return true;
    },
    canToggleEditor: () => true,
    isAnnotating: () => annotating,
  };

  return {
    handlers,
    calls,
    bindings,
    /** Switch the layer's activation, as pressing `A` really does. */
    setAnnotating: (value: boolean) => {
      annotating = value;
    },
  };
}

/**
 * The user's rule, stated as tests: **inactive means not ours, even if nobody else wants it.**
 *
 * The defect this pins: `Ctrl+Z` was still recognised as this layer's command while the layer
 * was off. The command then returned false ("nothing to undo"), so the *action* was correct —
 * but the chord had already been claimed, and a claimed chord is swallowed on `keyup` and
 * `keypress` too. From the browser's point of view the layer had taken the key and done
 * nothing with it, which is the one outcome that must never happen (found.md F-092).
 */
describe("inactive: this layer touches nothing", () => {
  /** Record every call the policy makes into the event, on every phase it listens to. */
  function phases() {
    const target = fakeTarget();
    const { handlers, calls } = dispatcher({}, { annotating: false });
    installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);
    return { target, calls };
  }

  it("does not claim Ctrl+Z at all", () => {
    const { target, calls } = phases();
    const down = keyEvent("KeyZ", { ctrl: true });
    target.fire("keydown", down);

    expect(calls).toEqual([]);
    expect(down.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it("does not swallow the keyup of Ctrl+Z either", () => {
    /*
     * The subtle half of the bug. Claiming a command swallows its non-keydown phases
     * unconditionally, so even a command that declined to run could keep the key from ever
     * completing. Nothing of ours may touch any phase while inactive.
     */
    const { target } = phases();
    const up = keyEvent("KeyZ", { ctrl: true });
    target.fire("keyup", up);
    expect(up.stopImmediatePropagation).not.toHaveBeenCalled();

    const press = keyEvent("KeyZ", { ctrl: true });
    target.fire("keypress", press);
    expect(press.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("does not claim any other drawing command while inactive", () => {
    // The same rule for the rest of the table: undo, redo, tools, prompt, board.
    for (const [code, options] of [
      ["KeyZ", { ctrl: true }],
      ["KeyZ", { ctrl: true, shift: true }],
      ["KeyS", { ctrl: true }],
      ["KeyB", { ctrl: true }],
      ["Digit1", { ctrl: true, shift: true }],
      ["Digit3", { ctrl: true, shift: true }],
    ] as const) {
      const { target, calls } = phases();
      const event = keyEvent(code, options);
      target.fire("keydown", event);
      expect(calls).toEqual([]);
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });

  it("still claims the two commands that reach the layer from off", () => {
    // Activation and visibility must work while inactive; they are the way back in.
    const { target, calls } = phases();
    target.fire("keydown", keyEvent("KeyA", { ctrl: true }));
    expect(calls).toEqual(["toggleAnnotate"]);

    target.fire("keydown", keyEvent("KeyH", { ctrl: true }));
    expect(calls).toEqual(["toggleAnnotate", "toggleVisible"]);
  });

  it("claims the drawing commands again once active", () => {
    // The complement: activation changes ownership, not the binding.
    const target = fakeTarget();
    const { handlers, calls } = dispatcher({}, { annotating: true });
    installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    target.fire("keydown", keyEvent("KeyZ", { ctrl: true }));
    expect(calls).toEqual(["undo"]);
  });
});

describe("active: a command that declines is still consumed", () => {
  it("swallows Ctrl+Z even when there is nothing to undo", () => {
    /*
     * The reported defect, in its general form: a bound command that returns false used to
     * hand the chord back. Active, that means the key reaches Studio — and inside the prompt
     * box it reaches the browser's text undo. "Active" has to mean the key stops here,
     * whether or not the layer did anything with it (found.md F-095).
     */
    const target = fakeTarget();
    const calls: CommandId[] = [];
    const handlers: ShortcutHandlers = {
      commandFor: (event) => (matches(defaultBindings().undo, event) ? "undo" : null),
      runCommand: (id) => {
        calls.push(id);
        return false;
      },
      isAnnotating: () => true,
    };
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const event = keyEvent("KeyZ", { ctrl: true });
    target.fire("keydown", event);

    expect(calls).toEqual(["undo"]);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    uninstall();
  });

  it("still hands the same chord back while inactive", () => {
    // Inactive, "nothing to undo" really does mean the field's own Ctrl+Z should run.
    const target = fakeTarget();
    const handlers: ShortcutHandlers = {
      commandFor: () => null,
      runCommand: () => false,
      isAnnotating: () => false,
    };
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const event = keyEvent("KeyZ", { ctrl: true });
    target.fire("keydown", event);
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    uninstall();
  });
});

describe("MOUSE_ONLY_POLICY", () => {
  it("blocks Studio's single-key bindings", () => {
    for (const code of ["KeyF", "KeyS", "KeyR", "KeyK", "Space", "ArrowLeft", "KeyJ", "KeyL"]) {
      expect(MOUSE_ONLY_POLICY.allows(code)).toBe(false);
    }
  });

  it("keeps Escape, because cancelling has no mouse equivalent", () => {
    expect(MOUSE_ONLY_POLICY.allows("Escape")).toBe(true);
    expect(MOUSE_ONLY_POLICY.safetyValves.Escape).toContain("Cancels");
  });

  it("declares every category as disabled so the UI can state it plainly", () => {
    expect(MOUSE_ONLY_POLICY.disabledCategories).toEqual([
      "playback",
      "timeline",
      "editing",
      "panel",
      "navigation",
    ]);
  });
});

describe("PERMISSIVE_POLICY", () => {
  it("allows everything, for the escape hatch", () => {
    expect(PERMISSIVE_POLICY.allows("KeyF")).toBe(true);
    expect(PERMISSIVE_POLICY.disabledCategories).toEqual([]);
  });
});

describe("commands run before the typing check", () => {
  it("fires Ctrl+S even with the caret inside a text field", () => {
    /*
     * Active: the command table outranks the typing check. `Ctrl+S` is this layer's own
     * vocabulary; nothing in a text field means it.
     */
    /*
     * This is the bug the modifier exists to prevent: the prompt box is a
     * contenteditable, so every keystroke there counts as typing. If the typing check
     * ran first, the shortcut that appends to that very box could never fire from it.
     */
    const target = fakeTarget();
    const { handlers, calls } = dispatcher({}, { annotating: true });
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const textarea = { tagName: "TEXTAREA", isContentEditable: false, getAttribute: () => null };
    const event = keyEvent("KeyS", { ctrl: true, path: [textarea] });
    target.fire("keydown", event);

    expect(calls).toEqual(["addToPrompt"]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    uninstall();
  });

  it("leaves Ctrl+Z to a focused text field, so the box undoes its own typing", () => {
    /*
     * Reversed from the original rule, on the user's explicit instruction: a focused text box
     * gets `Ctrl+Z` and undoes its own text, in both states. Drawing undo is reached from
     * outside a field (where it is the only claimant) — and the toolbar button always works.
     */
    const target = fakeTarget();
    const { handlers, calls } = dispatcher({}, { annotating: true });
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const box = { tagName: "DIV", isContentEditable: true, getAttribute: () => null };
    target.fire("keydown", keyEvent("KeyZ", { ctrl: true, path: [box] }));

    expect(calls).toEqual([]);
    uninstall();
  });

  it("leaves Ctrl+A to the text field, so it selects the paragraph instead of deactivating", () => {
    /*
     * The reported defect: with the caret in some text field and the layer **inactive**,
     * `Ctrl+A` toggled annotation mode on. "Select all" is the field's own meaning, and an
     * inactive layer has no business taking it.
     */
    const target = fakeTarget();
    const { handlers, calls } = dispatcher({}, { annotating: false });
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const box = { tagName: "DIV", isContentEditable: true, getAttribute: () => null };
    const event = keyEvent("KeyA", { ctrl: true, path: [box] });
    target.fire("keydown", event);

    expect(calls).toEqual([]);
    // Not swallowed either: the field's own select-all has to run.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    uninstall();
  });

  it("still activates annotation mode on Ctrl+A when the caret is not in text", () => {
    // The yield is about text, not about the key: outside a field the chord is ours.
    const target = fakeTarget();
    const { handlers, calls } = dispatcher();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    target.fire("keydown", keyEvent("KeyA", { ctrl: true, path: [] }));
    expect(calls).toEqual(["toggleAnnotate"]);
    uninstall();
  });

  it("yields only the chord a text field actually reserves", () => {
    /*
     * The rule keys on the chord, not merely on "this command is in the set": a rebind to
     * `Ctrl+Shift+A` is not something any text field claims, so it must keep working there.
     * Testing the predicate directly is the honest form — the default table binds that
     * chord to nothing, so routing an event through it would only prove it is unbound.
     */
    const ctrlA = { code: "KeyA", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    const ctrlShiftA = { ...ctrlA, shiftKey: true };
    const plainA = { ...ctrlA, ctrlKey: false };
    expect(yieldsToTextEditing("toggleAnnotate", ctrlA)).toBe(true);
    expect(yieldsToTextEditing("toggleAnnotate", ctrlShiftA)).toBe(false);
    expect(yieldsToTextEditing("toggleAnnotate", plainA)).toBe(false);
    // Nothing else yields, so Ctrl+S / Ctrl+Z keep working from inside the prompt box.
    expect(yieldsToTextEditing("addToPrompt", ctrlA)).toBe(false);
    expect(yieldsToTextEditing("undo", ctrlA)).toBe(false);
  });

  it("never fires a command for a plain letter, so typing is untouched", () => {
    const target = fakeTarget();
    const { handlers, calls } = dispatcher();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    // Even with focus nowhere in particular: a bare `a` is text, not a command.
    target.fire("keydown", keyEvent("KeyA"));
    expect(calls).toEqual([]);
    uninstall();
  });
});

describe("unhandled commands fall through", () => {
  it("leaves the key alone when the command refuses to act", () => {
    /*
     * `E` outside fullscreen, or undo with an empty stack, must not be swallowed — the
     * key keeps whatever meaning it had. Swallowing it would make a shortcut silently
     * become a dead key.
     */
    const target = fakeTarget();
    const handlers: ShortcutHandlers = {
      commandFor: () => "undo",
      runCommand: () => false,
      canToggleEditor: () => false,
      isAnnotating: () => false,
    };
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const event = keyEvent("KeyZ", { ctrl: true });
    target.fire("keydown", event);

    // The generic modifier branch still hides it from Studio, but our command handler
    // did not claim it.
    expect(event.preventDefault).not.toHaveBeenCalled();
    uninstall();
  });

  it("does not act on E while active but not fullscreen, and still keeps it from Studio", () => {
    /*
     * `E` needs the video fullscreen to have anything to do. While the layer is active it
     * must not act — but it also must not hand the chord back, because "active" means the
     * layer owns the keyboard. Handing it back was the general shape of the reported bug:
     * a key the layer declines became a key that reached Studio (found.md F-095).
     *
     * Inactive, the same chord is genuinely Studio's and is passed through — covered by the
     * ownership tests below.
     */
    const target = fakeTarget();
    const calls: CommandId[] = [];
    const handlers: ShortcutHandlers = {
      commandFor: () => "toggleEditor",
      runCommand: (id) => {
        calls.push(id);
        return true;
      },
      canToggleEditor: () => false,
      isAnnotating: () => true,
    };
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    const event = keyEvent("KeyE", { ctrl: true });
    target.fire("keydown", event);
    expect(calls).toEqual([]);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    uninstall();
  });
});

describe("annotation-only commands require annotation mode", () => {
  it("does not run a tool command while not annotating", () => {
    const target = fakeTarget();
    const calls: CommandId[] = [];
    const handlers: ShortcutHandlers = {
      commandFor: () => "toolEraser",
      runCommand: (id) => {
        calls.push(id);
        return true;
      },
      canToggleEditor: () => false,
      isAnnotating: () => false,
    };
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);
    target.fire("keydown", keyEvent("Digit5", { ctrl: true }));
    expect(calls).toEqual([]);
    uninstall();
  });
});

describe("binding matching includes modifiers both ways", () => {
  it("does not confuse Ctrl+Z with Ctrl+Shift+Z", () => {
    const { handlers, calls } = dispatcher({}, { annotating: true });
    const target = fakeTarget();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    target.fire("keydown", keyEvent("KeyZ", { ctrl: true, shift: true }));
    expect(calls).toEqual(["redo"]);
    uninstall();
  });

  it("honours a rebinding without any code change", () => {
    // The whole point of a configurable system: the same key routed differently.
    const { handlers, calls } = dispatcher({
      toggleAnnotate: binding("KeyJ", { ctrl: true }),
    });
    const target = fakeTarget();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    target.fire("keydown", keyEvent("KeyJ", { ctrl: true }));
    expect(calls).toEqual(["toggleAnnotate"]);

    // The default is no longer bound to anything.
    calls.length = 0;
    target.fire("keydown", keyEvent("KeyA", { ctrl: true }));
    expect(calls).toEqual([]);
    uninstall();
  });
});

describe("held keys and duplicate listeners", () => {
  it("ignores key repeat instead of firing dozens of times", () => {
    const { handlers, calls } = dispatcher();
    const target = fakeTarget();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);

    target.fire("keydown", keyEvent("KeyA", { ctrl: true }));
    expect(calls).toHaveLength(1);
    for (let index = 0; index < 30; index += 1) {
      target.fire("keydown", keyEvent("KeyA", { ctrl: true, repeat: true }));
    }
    expect(calls).toHaveLength(1);
    uninstall();
  });

  it("fires once when the top window and the iframe both see the press", () => {
    // Two independent event objects for one physical press (found.md F-021).
    const { handlers, calls } = dispatcher();
    const top = fakeTarget();
    const frame = fakeTarget();
    const uninstall = installShortcutPolicyOnFrame(
      MOUSE_ONLY_POLICY,
      frame as unknown as Window,
      top as unknown as Window,
      handlers,
    );

    const stamp = 12_345;
    top.fire("keydown", keyEvent("KeyA", { ctrl: true, timeStamp: stamp }));
    frame.fire("keydown", keyEvent("KeyA", { ctrl: true, timeStamp: stamp }));

    expect(calls).toHaveLength(1);
    uninstall();
  });

  it("removes every listener on uninstall", () => {
    const target = fakeTarget();
    const { handlers } = dispatcher();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);
    uninstall();
    for (const listeners of target.listeners.values()) expect(listeners).toHaveLength(0);
  });
});

describe("safety valve", () => {
  it("lets Escape through untouched", () => {
    const target = fakeTarget();
    const { handlers } = dispatcher();
    const uninstall = installShortcutPolicy(MOUSE_ONLY_POLICY, target as unknown as Window, handlers);
    const event = keyEvent("Escape");
    target.fire("keydown", event);
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    uninstall();
  });
});
