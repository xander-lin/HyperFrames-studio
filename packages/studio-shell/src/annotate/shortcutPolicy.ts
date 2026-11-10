/**
 * Keyboard policy.
 *
 * Product decision: **every** single-key shortcut in the upstream Studio is
 * disabled. Video work is spatial; making the user memorise J/K/L before they can
 * play backwards is a barrier, not efficiency.
 *
 * "Mouse-only" does not mean "no key at all", though. Only two kinds genuinely
 * need the keyboard:
 *
 * 1. **Safety valves**: no mouse equivalent exists, and disabling them would
 *    create an unrecoverable state.
 * 2. **Mode switches**: `A` enters annotation mode, `E` summons the editor float.
 *    Their whole value is that the hand does not leave the picture — clicking a
 *    button moves the eye away from the content.
 *
 * So the policy has two layers:
 * - `allows(code)` decides whether Studio may see the key (false everywhere
 *   except safety valves).
 * - `OUR_KEYS` / `TOOL_KEYS` are the keys the annotation layer consumes itself,
 *   handled before Studio and marked as consumed.
 *
 * Critical implementation detail: recognising "is this our key" must happen in the
 * **capture phase and before Studio**, on both the top window and the preview
 * iframe's window (see found.md F-019).
 */

import { isActiveOnlyCommand } from "./commands.js";
import type { CommandId } from "./commands.js";
import type { KeyEventLike } from "./keybinding.js";
import { isSafetyValve, isTextEditingCode, isZoomChord, keyOwner } from "./keyOwnership.js";

/** Upstream Studio keyboard actions that can be disabled wholesale. */
export type StudioHotkeyCategory =
  | "playback"
  | "timeline"
  | "editing"
  | "panel"
  | "navigation";

/** Keys that stay live, each with its justification. No reason, no entry. */
const SAFETY_VALVES: Readonly<Record<string, string>> = {
  Escape: "Cancels the current operation; no mouse equivalent",
  Enter: "Confirms what was typed in an input",
};

/**
 * The annotation layer's own shortcut table.
 *
 * Every key here must have a mouse entry point (a toolbar button). The keyboard
 * is an accelerator only; otherwise "you must remember the shortcut to use it",
 * which is the opposite of this project's philosophy.
 *
 * ## Every key carries `Ctrl` (or `Cmd` on macOS)
 *
 * This is not decoration. A bare letter is a **typing** key: the moment a text field
 * anywhere on the page has the caret, `s` must produce the letter `s`, and the number
 * row must produce digits. Binding bare letters to actions means every one of them is
 * one stray keystroke away from doing something the user did not ask for, and it makes
 * the tool unusable the instant focus is not where you expected.
 *
 * The modifier also settles the ownership question: `Ctrl`-combinations are commands,
 * not text, so the annotation layer can claim them without guessing whether the user
 * "meant to type that".
 *
 * `Escape` stays unmodified: it is a safety valve, and a safety valve that requires a
 * chord is not a safety valve.
 */
/*
 * The key table no longer lives here.
 *
 * It moved to `commands.ts` because it is **user-configurable**: keeping a second,
 * hard-coded copy in the policy would mean the settings screen could change the binding
 * while the policy still matched the old one. This module now only knows *how* to route
 * a key to a command, never *which* key that is.
 */

/**
 * Whether the event carries the modifier that makes a key a **command** rather than
 * text.
 *
 * `metaKey` is accepted so the same table works on macOS, where `Cmd` is the
 * customary modifier. `altKey` is rejected: `Alt` produces characters on many keyboard
 * layouts and is used by window managers.
 */
export function hasCommandModifier(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

export interface ShortcutPolicy {
  /** Whether Studio may handle this code. */
  allows(code: string): boolean;
  /** Disabled categories, for UI copy. */
  readonly disabledCategories: readonly StudioHotkeyCategory[];
  /** Retained safety valves and why. */
  readonly safetyValves: Readonly<Record<string, string>>;
}

const ALL_CATEGORIES: readonly StudioHotkeyCategory[] = [
  "playback",
  "timeline",
  "editing",
  "panel",
  "navigation",
];

/**
 * Mouse-only policy: nothing reaches Studio except the safety valves.
 *
 * Matching is done on `code`, not `key`: `key` is affected by input method, layout
 * and modifiers (under Caps Lock `key` may be `"ESCAPE"`), while `code` is the
 * physical key and much more stable.
 */
export const MOUSE_ONLY_POLICY: ShortcutPolicy = {
  allows: (code) => Object.hasOwn(SAFETY_VALVES, code),
  disabledCategories: ALL_CATEGORIES,
  safetyValves: SAFETY_VALVES,
};

/** Pass everything through: for debugging or when the user asks for upstream feel. */
export const PERMISSIVE_POLICY: ShortcutPolicy = {
  allows: () => true,
  disabledCategories: [],
  safetyValves: SAFETY_VALVES,
};

/**
 * Is this a keyboard event?
 *
 * Not `instanceof KeyboardEvent`: the top window and an iframe each have their own
 * constructor, so a cross-realm event fails the check and a real keypress would be
 * silently let through.
 */
function isKeyboardLike(event: Event): event is KeyboardEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "code" in event &&
    typeof (event as { code: unknown }).code === "string" &&
    "composedPath" in event &&
    typeof (event as { composedPath: unknown }).composedPath === "function"
  );
}

/**
 * Does any node on the event path accept text input?
 *
 * Every match must be let through, otherwise the user cannot even type spaces,
 * backspaces or arrow keys.
 */
function isEditableNode(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;

  const tag = "tagName" in node ? node.tagName : null;
  if (typeof tag === "string") {
    const upper = tag.toUpperCase();
    if (upper === "INPUT" || upper === "TEXTAREA" || upper === "SELECT") return true;
  }

  if ("isContentEditable" in node && node.isContentEditable === true) return true;

  if ("getAttribute" in node && typeof node.getAttribute === "function") {
    try {
      if (node.getAttribute("role") === "textbox") return true;
    } catch {
      // Some synthetic nodes throw from getAttribute; ignoring is fine.
    }
  }

  return false;
}

/**
 * Dedupe state.
 *
 * A module-level map rather than a flag on the event: one physical keypress in the
 * top window and the iframe produces two **independent** event objects, and a flag
 * cannot cross them (found.md F-021).
 */
const recentKeys = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 60;

/** Has this code just been handled? Also prunes stale entries so the map stays small. */
function isDuplicate(code: string, timeStamp: number): boolean {
  const previous = recentKeys.get(code);
  const now = timeStamp > 0 ? timeStamp : Date.now();
  if (previous !== undefined && Math.abs(now - previous) < DUPLICATE_WINDOW_MS) return true;
  recentKeys.set(code, now);
  // Keep only the newest entries; the map must not hold state forever.
  if (recentKeys.size > 16) {
    const oldest = [...recentKeys.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recentKeys.delete(oldest[0]);
  }
  return false;
}

/** Reset dedupe state; for tests. */
export function resetShortcutDedupe(): void {
  recentKeys.clear();
}

/** Whether the event happened inside a control that consumes character input. */
export function isTypingEvent(event: Event): boolean {
  if (!isKeyboardLike(event)) return false;
  for (const node of event.composedPath()) {
    if (isEditableNode(node)) return true;
  }
  return false;
}

/**
 * Commands that a text field already means, so the field keeps them while typing.
 *
 * `Ctrl+A` is "select all" in every text field ever built. Taking it means the user cannot
 * select the paragraph they are writing — and, as happened here, the same press also
 * toggles annotation mode off, closing the prompt box mid-sentence.
 *
 * This is not a weakening of "commands before the typing check". That rule exists so a
 * shortcut is not swallowed *just because* the caret happens to be in a field. These
 * chords are a different case: while typing they were never ours, because the field has a
 * stronger and universal claim to them.
 *
 * Deliberately **not** here: `Ctrl+S`, `Ctrl+E`, the tool digits, undo/redo and the board
 * toggle. Those are this layer's own vocabulary, nothing in a text field means them, and
 * they must keep working wherever the caret is.
 *
 * Keyed by command id rather than by key code: bindings are user-configurable, and this is
 * a statement about **meaning**, not about which physical key carries it today.
 */
const TEXT_EDITING_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  // As soon as a command means the same thing a text field means by that chord, it belongs
  // in this set. There is exactly one such command today; the set documents the rule.
  "toggleAnnotate",
]);

/**
 * Whether this command must step aside while the caret is in a text field.
 *
 * `toggleAnnotate` is here only because its default chord is `Ctrl+A`. If the user rebinds
 * it to something else, the yield still applies — deliberately: the check is "does pressing
 * this command here mean select-all instead", and the answer is taken from the chord.
 */
export function yieldsToTextEditing(command: CommandId, event: KeyEventLike): boolean {
  if (!TEXT_EDITING_COMMANDS.has(command)) return false;
  /*
   * Only the combinations a text field actually reserves. Asking "is the command in the
   * set" alone would make `Ctrl+Shift+A` yield too, which would be a new hole rather than
   * a fix — the rule has to match the chord the user pressed.
   */
  return event.code === "KeyA" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export interface ShortcutHandlers {
  /**
   * Which command, if any, this event triggers.
   *
   * Supplied by the caller because the binding table is user-configurable: the policy
   * must not contain a second, hard-coded copy of the shortcuts. Returning null means
   * "nothing of ours", and the event continues on its normal path.
   */
  readonly commandFor?: (event: KeyEventLike) => CommandId | null;
  /** Run one command. Returns whether it actually did something. */
  readonly runCommand?: (id: CommandId) => boolean;
  /** Whether `E` belongs to us right now; see `canToggleEditor` below. */
  readonly canToggleEditor?: () => boolean;
  /**
   * `Ctrl/Cmd + =` / `-` / `0`: interface zoom.
   *
   * Returning true means consumed (the caller swallows the event so Studio does
   * not also react).
   */
  readonly onZoom?: (event: KeyboardEvent) => boolean;
  /** Whether annotation mode is on — annotation-only commands require it. */
  readonly isAnnotating?: () => boolean;
}


/**
 * Run one command, checking whether it is meaningful **now**.
 *
 * Returning false leaves the key alone instead of consuming it, which is what keeps a
 * shortcut from silently becoming a no-op: `E` outside fullscreen falls through to
 * Studio, and `undo` with nothing on the stack does the same.
 */
function runCommand(id: CommandId, event: Event, handlers: ShortcutHandlers): boolean {
  switch (id) {
    case "toggleAnnotate":
      return handlers.runCommand?.(id) ?? false;
    case "toggleVisible":
      return handlers.runCommand?.(id) ?? false;
    case "toggleEditor":
      /*
       * `E` is only ours in fullscreen video.
       *
       * Outside fullscreen the Design panel is already in the layout, so taking the key
       * would leave two copies of the same state and block a key the user expects to
       * work. Checked here rather than in the binding table because the table is static
       * and this is a fact about the current screen.
       */
      if (!handlers.canToggleEditor?.()) return false;
      return handlers.runCommand?.(id) ?? false;
    case "addToPrompt":
    case "toolRegion":
    case "toolArrow":
    case "toolFreehand":
    case "toolEraser":
    case "toolSelect":
    case "undo":
    case "redo":
    case "toggleBoard":
      // Annotation-only: outside the mode these keys keep their normal meaning.
      if (!handlers.isAnnotating?.()) return false;
      return handlers.runCommand?.(id) ?? false;
  }
}

/**
 * Install the keyboard policy.
 *
 * The ownership decision lives in `keyOwnership.ts`; this function only routes to it and
 * then acts. Three outcomes, three behaviours:
 *
 * 1. **`command`** — run it, and swallow the event so Studio never sees it.
 * 2. **`block`** — the layer is active and the key is not a command: swallow it and do
 *    nothing. Studio's playback and timeline keys are single letters, so "not mine" must
 *    mean "nobody's" while this layer has the keyboard.
 * 3. **`pass`** — leave the event completely alone: `Escape`/`Enter`, the chords a focused
 *    text field means by itself, and everything at all while the layer is inactive.
 *
 * `policy.allows` no longer decides individual keys: it survives only as the statement of
 * which Studio categories are disabled, for the UI. Blocking is decided by activation, not
 * by a key list — a list cannot say "everything is ours right now".
 *
 * Returns an uninstall function.
 */
export function installShortcutPolicy(
  policy: ShortcutPolicy,
  target: Document | Window = window,
  handlers?: ShortcutHandlers,
): () => void {
  const handler = (event: Event): void => {
    // Duck typing instead of `instanceof KeyboardEvent`: across realms (iframe,
    // test environment) instanceof fails and real events get let through.
    if (!isKeyboardLike(event)) return;

    const keyboard = event as KeyboardEvent;
    const isKeyDown = event.type === "keydown";

    /*
     * Commands first, before **any** typing check.
     *
     * This ordering is the whole point of requiring a modifier. A command like
     * `Ctrl+S` is not text, so it must not be filtered out just because the caret
     * happens to be in a text field — otherwise the prompt box would swallow the very
     * shortcut that adds to it, and `Ctrl+Z` there would undo typed words instead of
     * the line the user just drew.
     *
     * **Except for chords a text field already means.** `Ctrl+A` is "select all" every
     * time the caret is in text, and it is not a preference: taking it means the user
     * cannot select the paragraph they are writing, and the press also flips annotation
     * mode off, so the prompt box closes under their hands. Those chords are listed in
     * `editingChords` and are handed back to the field.
     *
     * The distinction is not "modifier or not" but **who the chord already belongs to**:
     * a text field owns the editing chords, and this layer owns everything else it binds.
     */
    const command = handlers?.commandFor?.(keyboard) ?? null;
    const typing = isTypingEvent(event);
    const capturing = handlers?.isAnnotating?.() ?? false;

    /*
     * One ownership decision, then three ways to act on it. See `keyOwnership.ts` for why
     * this is not a list of "our keys": active means *everything* is ours, and that is not
     * expressible by listing keys.
     */
    const owner = keyOwner({
      capturing,
      command,
      typing,
      /*
       * A **chord**, not a key: `Ctrl+A` is the field's, a bare `A` is text. Checking only the
       * physical code made every `A` press in the prompt box fall through to Studio's in-point
       * key (found.md F-125).
       */
      textEditingChord: isTextEditingCode(keyboard.code, {
        modified: keyboard.ctrlKey || keyboard.metaKey,
      }),
      commandYieldsToText: command !== null && yieldsToTextEditing(command, keyboard),
      commandIsActiveOnly: command !== null && isActiveOnlyCommand(command),
      safetyValve: isSafetyValve(keyboard.code),
      zoomChord: isZoomChord(keyboard),
    });

    if (owner === "pass") {
      /*
       * Nothing of ours.
       *
       * Still swallow single keys when this layer is active — that is `owner === "block"`
       * below — but here the event keeps whatever meaning it had. The one extra rule is the
       * zoom chord, which is not a table entry (it means different things per surface).
       */
      if (
        (keyboard.metaKey || keyboard.ctrlKey) &&
        !keyboard.altKey &&
        handlers?.onZoom?.(keyboard)
      ) {
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      return;
    }

    if (owner === "block-keep-default") {
      /*
       * Consumed by this layer, but the browser's default still runs.
       *
       * Two cases, and they are the same case — the default **is** the action, so suppressing it
       * would break what the key is for:
       *
       * - typing: the default is the character;
       * - `Escape`: the default cancels an input-method composition or closes a control.
       *
       * ## Why the event is not stopped here
       *
       * This listener sits on `window` in the **capture** phase, the outermost point of the
       * chain. Stopping it there means the event never reaches its own target — the editor — and
       * the character is never typed.
       *
       * ## So what keeps Studio out?
       *
       * Not this branch: `inert` on Studio's root (`studioSuspend.ts`). That is a browser-level
       * statement that the subtree is not interactive, so its handlers cannot run for events
       * inside this layer at all. Relying on Studio's own "is this a text field" guards would be
       * luck — 16 of its 38 keydown listeners have no such guard (found.md F-125).
       *
       * This split is why the two mechanisms exist side by side:
       *
       * | concern | owner |
       * |---|---|
       * | the character appears | this branch (stay out of the way) |
       * | Studio cannot react | `inert` |
       * | no key leaves this layer | the `block` branch, for everything else |
       *
       * The zoom chord arrives here too, and it is **offered to the handler** rather than being
       * consumed silently: deciding which surface a zoom resizes needs the layer's own state,
       * which lives there. `onZoom` returning false means nobody wanted it, and in that case the
       * default is left alone anyway — this branch never cancels it.
       */
      if ((keyboard.metaKey || keyboard.ctrlKey) && !keyboard.altKey) {
        handlers?.onZoom?.(keyboard);
      }
      return;
    }

    if (owner === "block") {
      /*
       * Active, and not a command: this layer is in charge, so **nothing else may act**.
       *
       * Both halves matter, and the second one was missing:
       *
       * - `stopPropagation` cuts off Studio's listeners;
       * - `preventDefault` cuts off the **browser's own** default action.
       *
       * Without the second, `Space` while a toolbar button happened to hold focus pressed
       * that button. Nothing in either key table was involved — the browser did it — so the
       * key "pierced through" while every listener correctly reported it never saw the
       * event (found.md F-094). The same applies to arrow-key scrolling and to a focused
       * checkbox being toggled.
       *
       * `typing` is the one exception: in a text field the browser's default *is* the text.
       * Blocking it would make the prompt box untypable while active.
       */
      /*
       * No `typing` exception here any more: the cases that need the default left alive
       * (typing, `Escape`) are answered as `block-keep-default` above. Reaching `block` now
       * means "consume and cancel", unconditionally — one answer per situation instead of a
       * condition assembled from two facts at the call site.
       */
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    // owner === "command"
    // Held keys must not fire dozens of times per second.
    if (keyboard.repeat) return;
    /*
     * One physical keypress is seen by several listeners — the top window and the preview
     * iframe each receive their own event object — so a flag on the event cannot cross
     * them. Dedupe by (code, time window) instead (found.md F-021).
     */
    if (isDuplicate(keyboard.code, keyboard.timeStamp)) return;

    if (!isKeyDown) {
      // keyup/keypress of a command: swallow so it does not leak to Studio.
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    const handled = handlers ? runCommand(command as CommandId, event, handlers) : false;
    /*
     * A command that ran is consumed; a command that declined is handed back **only while
     * the layer is inactive**, where "nothing to undo" legitimately means the field's own
     * `Ctrl+Z` should run.
     *
     * While active it must still be consumed. `Ctrl+Z` with nothing to undo used to fall
     * through to the browser here, so the keystroke reached Studio and, inside the prompt
     * box, the browser's text undo — the exact "the layer is active but the key pierced
     * through" report (found.md F-095). Active means the key stops here either way; the
     * difference is whether the layer did something or deliberately did nothing.
     */
    if (!handled && !capturing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  target.addEventListener("keydown", handler, { capture: true });
  target.addEventListener("keyup", handler, { capture: true });
  target.addEventListener("keypress", handler, { capture: true });
  return () => {
    target.removeEventListener("keydown", handler, { capture: true });
    target.removeEventListener("keyup", handler, { capture: true });
    target.removeEventListener("keypress", handler, { capture: true });
  };
}

/**
 * Install the policy on both the top window and the preview iframe's window.
 *
 * Why two: Studio's `useAppHotkeys` attaches the same hotkey handlers to the
 * **preview iframe's window** (clicking the canvas moves focus into the iframe).
 * Installing only on top means that after the user clicks the canvas the events
 * stay inside the iframe and interception silently stops working (found.md F-019).
 */
export function installShortcutPolicyOnFrame(
  policy: ShortcutPolicy,
  frameWindow: Window | null,
  target: Document | Window = window,
  handlers?: ShortcutHandlers,
): () => void {
  const uninstallTop = installShortcutPolicy(policy, target, handlers);
  if (!frameWindow) return uninstallTop;

  let uninstallFrame: (() => void) | null = null;
  try {
    uninstallFrame = installShortcutPolicy(policy, frameWindow, handlers);
  } catch {
    // A cross-origin iframe cannot be listened to; top-level protection alone is
    // not a failure.
    uninstallFrame = null;
  }

  return () => {
    uninstallTop();
    uninstallFrame?.();
  };
}
