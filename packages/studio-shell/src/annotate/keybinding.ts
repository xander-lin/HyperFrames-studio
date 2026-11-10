/**
 * Key bindings: the data type, matching, and the rules for what may be bound.
 *
 * Deliberately pure: no React, no DOM beyond the shape of a `KeyboardEvent`. The whole
 * shortcut system is a table lookup, and keeping that lookup testable outside a browser
 * is what lets the rules below be verified rather than hoped for.
 *
 * ## Why bindings are not just a key code
 *
 * A bare key is a **typing** key. `s` must produce the letter `s` in any text field,
 * and the number row must produce digits. Binding bare keys to actions means every one
 * of them is one stray keystroke away from doing something unintended, and the tool
 * breaks as soon as focus is somewhere unexpected. A modifier makes a key a *command*
 * rather than text, which is the distinction a shortcut system needs.
 */

/** One key plus its modifiers. `code` is `KeyboardEvent.code` (physical key). */
export interface KeyBinding {
  readonly code: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/** A command may be left unbound; `null` means "this does nothing". */
export type Binding = KeyBinding | null;

/** The subset of `KeyboardEvent` that matching needs. */
export interface KeyEventLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Build a binding. Written out so call sites read like the key they describe. */
export function binding(
  code: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): KeyBinding {
  return {
    code,
    ctrl: modifiers.ctrl === true,
    shift: modifiers.shift === true,
    alt: modifiers.alt === true,
    meta: modifiers.meta === true,
  };
}

/** Read a binding off a live event. */
export function bindingFromEvent(event: KeyEventLike): KeyBinding {
  return {
    code: event.code,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
}

/**
 * Whether an event presses exactly this binding.
 *
 * Every modifier is compared both ways: a binding for `Ctrl+Z` must not fire on
 * `Ctrl+Shift+Z`, and a binding for `Ctrl+Shift+Z` must not fire on `Ctrl+Z`. Partial
 * matching would make the two indistinguishable.
 */
export function matches(bindingValue: Binding, event: KeyEventLike): boolean {
  if (!bindingValue) return false;
  return (
    event.code === bindingValue.code &&
    event.ctrlKey === bindingValue.ctrl &&
    event.shiftKey === bindingValue.shift &&
    event.altKey === bindingValue.alt &&
    event.metaKey === bindingValue.meta
  );
}

/** Function keys are commands on their own; nothing types them. */
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/**
 * Whether a binding is safe to assign to an action.
 *
 * The rule has one purpose: **a configurable shortcut must never steal a typing key.**
 *
 * - a modifier makes it a command (`Ctrl`, `Cmd`, `Alt`, `Shift` alone is not enough —
 *   `Shift+7` is still a character on most layouts);
 * - a bare function key is fine, because no layout types `F5`.
 *
 * `Escape` is rejected even with a modifier: it is the safety valve, and it is not
 * configurable at all (see `commands.ts`).
 */
export function isAllowedBinding(candidate: KeyBinding): boolean {
  if (candidate.code === "Escape") return false;
  // A lone modifier is not a binding.
  if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.test(candidate.code)) return false;
  const hasCommandModifier = candidate.ctrl || candidate.meta || candidate.alt;
  return hasCommandModifier || FUNCTION_KEY.test(candidate.code);
}

/** Why a binding was refused, or null when it is acceptable. */
export function explainRejection(candidate: KeyBinding): string | null {
  if (candidate.code === "Escape") {
    return "Escape is reserved: it cancels whatever is in progress and has no mouse equivalent";
  }
  if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.test(candidate.code)) {
    return "A modifier key alone cannot be a shortcut; add the key you want to press with it";
  }
  if (isAllowedBinding(candidate)) return null;
  if (FUNCTION_KEY.test(candidate.code)) return null;
  return "Add Ctrl, Cmd or Alt: a plain letter or digit has to stay available for typing";
}

/** Human-readable form, e.g. `Ctrl + Shift + Z`. */
export function formatBinding(bindingValue: Binding): string {
  if (!bindingValue) return "Unassigned";
  const parts: string[] = [];
  if (bindingValue.ctrl) parts.push("Ctrl");
  if (bindingValue.meta) parts.push("Cmd");
  if (bindingValue.alt) parts.push("Alt");
  if (bindingValue.shift) parts.push("Shift");
  parts.push(formatCode(bindingValue.code));
  return parts.join(" + ");
}

/** Turn a `code` into the label printed on a key. */
export function formatCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  switch (code) {
    case "Enter":
      return "Enter";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Delete";
    case "Tab":
      return "Tab";
    case "Space":
      return "Space";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backslash":
      return "\\";
    case "Backquote":
      return "`";
    default:
      return code;
  }
}

/** Stable key for a binding, used for comparison and conflict detection. */
export function bindingKey(bindingValue: KeyBinding): string {
  return [
    bindingValue.ctrl ? "C" : "",
    bindingValue.meta ? "M" : "",
    bindingValue.alt ? "A" : "",
    bindingValue.shift ? "S" : "",
    bindingValue.code,
  ]
    .filter(Boolean)
    .join("+");
}

/** Whether two bindings are the same key combination. */
export function sameBinding(a: Binding, b: Binding): boolean {
  if (!a || !b) return a === b;
  return bindingKey(a) === bindingKey(b);
}
