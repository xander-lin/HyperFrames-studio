/**
 * Who owns a keystroke: this annotation layer, or Studio underneath.
 *
 * ## The rule the product states
 *
 * - **Active** (`A` pressed, this layer takes input): every key belongs to this layer.
 *   Studio must see nothing.
 * - **Inactive**: nothing belongs to this layer, except the keys that bring it back or
 *   move its window — those are this layer's own chrome, not Studio's.
 *
 * That is the whole contract, and it is why the policy needs an explicit ownership answer
 * instead of a list of "our keys": a list can only ever say "this key is ours", never
 * "everything is ours right now".
 *
 * ## Why this is a separate, pure module
 *
 * Three bugs were reported against the same behaviour — `A` reaching the preview,
 * `Ctrl+Z` reaching the prompt box's text undo, `Ctrl+A` not toggling. Each looked like a
 * different defect because each had a different surface symptom, while the cause was one:
 * **the layer never blocked anything it did not recognise**. A rule that is not written
 * down cannot be enforced; this file is the enforcement, and `shortcutPolicy.ts` only
 * routes through it.
 */

import type { CommandId } from "./commands.js";

/** What this layer is allowed to do with one key event. */
export type KeyOwner =
  /** A command of this layer: run it and swallow the event. */
  | "command"
  /**
   * Not a command, but this layer has the keyboard and **must consume it**.
   *
   * "Consume" is two decisions, and the caller keeps them apart:
   *
   * - `stopPropagation` — **always**, so no other listener sees the key;
   * - `preventDefault` — unless the caret is in a text field, where the default *is* the
   *   character being typed.
   *
   * This is the answer for every key in the active state that is not a command: whether Studio
   * happens to bind it is irrelevant. The two states are two applications that must never reach
   * each other (found.md F-125).
   */
  | "block"
  /**
   * Consume the event **without** suppressing the browser's default action.
   *
   * For a key whose default a control inside this layer legitimately relies on, while nothing
   * outside may still act on it:
   *
   * - **typing** — the default *is* the character;
   * - **`Escape`** — it cancels an input method composition or closes a control the layer owns;
   *   suppressing it would trap the user in a state with no way out.
   *
   * The distinction is "consume" versus "cancel the default", and it is spelled out here rather
   * than assembled at the call site so that no future key can quietly get the wrong one.
   */
  | "block-keep-default"
  /**
   * Leave the event completely alone.
   *
   * **Only reachable while this layer is inactive.** The active state never returns it — see
   * the note at the top of `keyOwner`. Having a third value that means "let it through" is how
   * a bare letter could reach Studio at all, so it is confined to the state where letting keys
   * through is the whole point.
   */
  | "pass";

export interface OwnershipInput {
  /** Whether this layer currently owns the input (`A`). */
  readonly capturing: boolean;
  /** The command bound to this event, if any. */
  readonly command: CommandId | null;
  /**
   * Whether the caret is in a text field.
   *
   * Only matters **inactive**: active means the layer owns the keys, and the prompt box is
   * part of the layer (its text undo is reached by the command table, not by leaking
   * `Ctrl+Z` to the browser).
   */
  readonly typing: boolean;
  /**
   * Whether the pressed chord is one a text field means by itself (`Ctrl+A`, `Ctrl+C`,
   * `Ctrl+V`, `Ctrl+X`, `Ctrl+Z`).
   *
   * Handed back to the field **while inactive**, because then the field is real editing:
   * selecting a paragraph in the prompt box with the layer off must select text.
   */
  readonly textEditingChord: boolean;
  /**
   * Whether the matched command only exists **while this layer is active**.
   *
   * Undo, redo, the tools, "add to prompt", the board toggle: none of them mean anything
   * with the layer off, so the layer must not even *claim* them. Claiming is not harmless —
   * a claimed chord is swallowed on `keyup`/`keypress` even when the command then declines
   * to run, so the key would still never reach the field that owns it (found.md F-092).
   */
  readonly commandIsActiveOnly: boolean;
  /**
   * Whether the chord names a command that a text field already means.
   *
   * `Ctrl+A` is both this layer's activation toggle **and** "select all". While the caret is
   * in a field the field's meaning wins, and that is a fact about the *command*, not about
   * the chord list: the user may have rebound the toggle, and then the yield has to follow
   * the new chord rather than stay on `KeyA`.
   */
  readonly commandYieldsToText: boolean;
  /**
   * Whether this key is one of the two safety valves (`Escape`, `Enter`).
   *
   * `Escape` cancels whatever is in progress and has no mouse equivalent; it must reach
   * the field that is waiting for it, active or not.
   */
  readonly safetyValve: boolean;
  /**
   * Whether this is the interface-zoom chord (`Ctrl` `+`/`-`/`0`).
   *
   * Zoom is not a table entry because it means different things per surface, so it would
   * otherwise fall into "a key I do not recognise" and be blocked — which is exactly what
   * happened: activating the layer killed `Ctrl` `+` entirely (found.md F-090).
   */
  readonly zoomChord: boolean;
}

/**
 * Decide, for one key event, whether this layer acts, blocks, or steps aside.
 *
 * Order matters and each step has a reason:
 *
 * 1. **Safety valves first.** `Escape`/`Enter` are not commands and must never be blocked;
 *    blocking `Escape` while a field is open would trap the user.
 * 2. **A bound command wins.** The binding table is user-configurable, so a command is a
 *    statement of intent that outranks every heuristic below.
 * 3. **Active blocks everything else.** This is the rule that was missing: Studio's
 *    playback and timeline keys are *single letters*, so "we do not have a command for it"
 *    cannot mean "Studio may have it" while this layer is active.
 * 4. **Inactive passes everything else**, except the keys the layer needs to be reachable
 *    again (those are commands and were handled at step 2), and except while a text field
 *    is focused — where the field's own editing chords are the field's.
 */
export function keyOwner(input: OwnershipInput): KeyOwner {
  /*
   * ## The one rule that has to hold in the active state
   *
   * "Active" means this layer owns the keyboard, **so nothing else may receive the event** —
   * regardless of what the key means, what it is bound to, or whether Studio happens to use it.
   * The user's words: "他就算是 B 也不行。就算下层对 B 没有反应，B 不应该穿透。跟这到底是什么键
   * 没关系"(found.md F-125).
   *
   * That is why the active branches below never return `pass`. `pass` does not mean "do
   * nothing" — it means **let the event continue**, which is exactly the leak. Two things are
   * separate and used to be conflated:
   *
   * - **who consumes the event** — in the active state, always this layer;
   * - **whether the browser's default action runs** — it must not, except for typing, where
   *   the default *is* the character.
   *
   * So the active state answers `block` (or `command`) every time, and the caller suppresses
   * propagation while leaving the default alone when the caret is in a text field.
   */
  /*
   * A safety valve is never swallowed by *another* state's rules, and while active it is still
   * this layer's — `block-keep-default` consumes it without taking away its default, so an open
   * input method or a control that is waiting for `Escape` still gets to cancel.
   */
  if (input.safetyValve) return input.capturing ? "block-keep-default" : "pass";
  /*
   * A chord the focused field already means goes to the field — before the command is run.
   *
   * This is not a hole in "commands first". `Ctrl+A` in text is "select all" in every text
   * field ever built; taking it made the user unable to select the paragraph they were
   * writing, and it also flipped the layer's mode, closing the box under their hands.
   */
  if (input.typing && input.commandYieldsToText) {
    return input.capturing ? "block-keep-default" : "pass";
  }
  /*
   * A focused field's editing chords are the field's, **in both states**.
   *
   * This must come **before** the command check below, because several of those chords are
   * also bound commands: `Ctrl+Z` is drawing undo, `Ctrl+A` is the activation toggle. Letting
   * the binding win here is what made a text box unable to undo its own typing while the
   * layer was active (found.md F-097). Typing is not a shortcut; it is why the field exists.
   */
  if (input.typing && input.textEditingChord) {
    return input.capturing ? "block-keep-default" : "pass";
  }
  /*
   * A command that only exists in the active state is **not ours** when inactive.
   *
   * This is the difference between "the command would do nothing" and "the key is not the
   * layer's". Dropping the claim entirely (rather than letting the command run and fail)
   * means the event is never swallowed — not on keydown, and not on the keyup/keypress that
   * a claimed chord also consumes.
   */
  if (!input.capturing && input.commandIsActiveOnly) return "pass";
  /*
   * Zoom is handled separately by the caller, because which surface it resizes depends on
   * activation. It is neither a command nor something to block: it must be *offered* to the
   * handler, and the handler decides whether it consumed the event.
   */
  if (input.zoomChord) return input.capturing ? "block-keep-default" : "pass";
  /*
   * A command is ours to run, even while typing: `Ctrl+S` must still add the block with the
   * caret in the box (found.md F-097).
   */
  if (input.command) return "command";
  /*
   * ## The caret is in a text field, and this key is not a command
   *
   * Everything below this line is still consumed by this layer — that is the invariant — but
   * whether the **character appears** is decided here, and the answer does not depend on whether
   * the key is one of the field's *chords*.
   *
   * That distinction was the second half of the reported defect. "Is it an editing chord?"
   * answers "does `Ctrl` combinatorics mean something special here?" — a bare `b` is not a
   * chord, and yet the field must still type it. Tying the two together made a bare letter
   * either leak out (the original bug) or become untypable (the naive fix). The fact that
   * actually matters is simply **the caret is in a field** (found.md F-125).
   */
  if (input.typing) return input.capturing ? "block-keep-default" : "pass";

  /*
   * Active: this layer owns the keyboard, full stop.
   *
   * There is deliberately no "except …" here any more. Every earlier branch either returned
   * `command` (ours to run) or `block` (ours to swallow), so reaching this point in the active
   * state means "not a command, not the field's chord" — and the answer for any such key is the
   * same whatever it is bound to elsewhere (found.md F-125).
   */
  if (input.capturing) return "block";

  // Inactive: nothing of ours. Whatever the key means to Studio or to the browser, it is
  // not this layer's business.
  return "pass";
}

/**
 * Whether this event is the interface-zoom chord.
 *
 * Matches on both `key` and `code`: `=`/`+` and `-`/`_` sit on different physical keys per
 * layout, and the numpad sends its own codes.
 */
export function isZoomChord(event: {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  // `Alt` is excluded: some layouts produce characters with it, and the policy refuses it.
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const { key, code } = event;
  return (
    key === "=" ||
    key === "+" ||
    code === "Equal" ||
    code === "NumpadAdd" ||
    key === "-" ||
    key === "_" ||
    code === "Minus" ||
    code === "NumpadSubtract" ||
    key === "0" ||
    code === "Digit0" ||
    code === "Numpad0"
  );
}

/** Whether a physical `code` is a safety valve. Mirrors `SAFETY_VALVES` in the policy. */
export function isSafetyValve(code: string): boolean {
  return code === "Escape" || code === "Enter";
}

/**
 * Chords a text field means by itself, as physical codes.
 *
 * ## The chord, not the key
 *
 * These are **`Ctrl`+letter** chords (`Ctrl+A` selects all, `Ctrl+Z` undoes typing). A bare `A`
 * is not one of them: it is the letter `a`, which the field types.
 *
 * Getting this wrong is not a subtle preference — it was the reported defect. The check looked
 * at the physical code alone, so **every** `A` pressed in the prompt box counted as "the field's
 * editing chord", the layer stepped aside, and the key fell through to Studio, where `A` is the
 * in-point key. The user's words: "在提示词文本框中反复敲击 A 这个 A 会穿透到视频预览框中"
 * (found.md F-125).
 *
 * `Backspace` / `Delete` are the exception that proves the rule: they are unmodified chords a
 * field really does own, because deleting a character is typing.
 *
 * Keyed by code rather than by `key`: `key` is rewritten by input methods and layouts, while
 * `code` is the physical position the user pressed.
 */
export function isTextEditingCode(code: string, modifiers: { readonly modified: boolean }): boolean {
  /*
   * Unmodified Backspace/Delete belong to the field in both states.
   *
   * Deliberately checked **before** `modified`, because they are the one pair where "no
   * modifier" is still a text edit.
   */
  if (code === "Backspace" || code === "Delete") return true;

  if (!modifiers.modified) return false;

  return code === "KeyA" || code === "KeyC" || code === "KeyV" || code === "KeyX" || code === "KeyZ";
}
