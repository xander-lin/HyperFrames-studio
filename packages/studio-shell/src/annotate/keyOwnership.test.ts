import { describe, expect, it } from "vitest";
import {
  isSafetyValve,
  isTextEditingCode,
  isZoomChord,
  keyOwner,
  type OwnershipInput,
} from "./keyOwnership.js";

/**
 * Who owns a keystroke.
 *
 * These are the three reported defects, expressed as rules instead of as key lists:
 *
 * 1. **Inactive, and `A` still reached the preview.** `A` is also Studio's "jump to
 *    in-point", so a bare letter has to be blocked rather than passed.
 * 2. **Inactive, and `Ctrl+Z` went to the prompt box's text undo** — correct, actually: an
 *    inactive layer has nothing to undo, and the field does.
 * 3. **`Ctrl+A` did not toggle**, because with the caret in a field the field means
 *    "select all".
 *
 * The point of testing the decision separately from the listener is that the listener can
 * be installed on any window and still produce these answers.
 */

const BASE: OwnershipInput = {
  capturing: false,
  command: null,
  typing: false,
  textEditingChord: false,
  commandYieldsToText: false,
  commandIsActiveOnly: false,
  safetyValve: false,
  zoomChord: false,
};

describe("active: the layer owns the keyboard", () => {
  it("runs a bound command", () => {
    expect(keyOwner({ ...BASE, capturing: true, command: "undo" })).toBe("command");
  });

  it("blocks a key it does not recognise, so Studio never sees it", () => {
    /*
     * The reported bug: bare `a` reached the preview and jumped to the in-point. `A` is not
     * one of this layer's commands, so by the old "allow what we do not know" rule it fell
     * through to Studio. While active, "not mine" must mean "nobody's".
     */
    for (const code of ["KeyA", "KeyS", "KeyJ", "KeyK", "Space", "BracketLeft"]) {
      void code;
      expect(keyOwner({ ...BASE, capturing: true })).toBe("block");
    }
  });

  it("still runs commands while the caret is in a text field", () => {
    // The prompt box is part of this layer: `Ctrl+S` there must add to the prompt.
    expect(
      keyOwner({ ...BASE, capturing: true, typing: true, command: "addToPrompt" }),
    ).toBe("command");
  });

  it("swallows the field's editing chords while still letting the field act", () => {
    /*
     * Two separate questions, and conflating them was the reported leak:
     *
     * - **who consumes the event** — this layer, always, while active;
     * - **whether the browser's default runs** — it does, because that default *is* the text.
     *
     * So the answer is `block`, and the caller suppresses propagation while leaving the default
     * alone for typing. Returning `pass` let the event continue past this layer entirely, which
     * is how a bare letter reached Studio's in-point key (found.md F-125).
     */
    expect(
      keyOwner({ ...BASE, capturing: true, typing: true, textEditingChord: true }),
    ).toBe("block-keep-default");
  });

  it("still lets Ctrl+A select text, while not letting it leave this layer", () => {
    /*
     * `Ctrl+A` with the caret in text is select-all. The field must perform it — so the caller
     * must not `preventDefault` — but the event must not travel on: nothing outside may act on
     * a key the layer already answered for (found.md F-125).
     */
    expect(
      keyOwner({
        ...BASE,
        capturing: true,
        typing: true,
        command: "toggleAnnotate",
        commandYieldsToText: true,
      }),
    ).toBe("block-keep-default");
  });
});

describe("inactive: nothing is ours", () => {
  it("passes every key it does not bind", () => {
    expect(keyOwner(BASE)).toBe("pass");
  });

  it("does not swallow Studio's playback letters", () => {
    // The preview is Studio's while the layer is off; `J`/`K`/`L` must reach it.
    for (const _ of [1, 2, 3]) expect(keyOwner(BASE)).toBe("pass");
  });

  it("still runs the commands that bring the layer back", () => {
    // Activation itself has to work, or the layer becomes unreachable.
    expect(keyOwner({ ...BASE, command: "toggleAnnotate" })).toBe("command");
    expect(keyOwner({ ...BASE, command: "toggleVisible" })).toBe("command");
  });

  it("leaves Ctrl+Z to the text field, which undoes its own typing", () => {
    /*
     * The user's requirement, verbatim: with the layer inactive, a focused text box must
     * get `Ctrl+Z` — the browser's text undo — even though Studio also binds undo to it.
     * "Typing target first" is the rule that makes both statements true: inside a field the
     * field wins; everywhere else Studio's undo runs.
     */
    expect(keyOwner({ ...BASE, typing: true, textEditingChord: true })).toBe("pass");
  });

  it("leaves Ctrl+A to the text field instead of toggling", () => {
    expect(
      keyOwner({ ...BASE, typing: true, command: "toggleAnnotate", commandYieldsToText: true }),
    ).toBe("pass");
  });
});

describe("an active-only command while inactive", () => {
  it("is not this layer's at all", () => {
    /*
     * `Ctrl+Z` bound to drawing undo, layer off. The command would do nothing, but that is
     * not the point: the layer must not *claim* the key, or it swallows it and the field
     * that owns the text undo never sees the press (found.md F-092).
     */
    expect(
      keyOwner({ ...BASE, capturing: false, command: "undo", commandIsActiveOnly: true }),
    ).toBe("pass");
  });

  it("is claimed again the moment the layer is active", () => {
    expect(
      keyOwner({ ...BASE, capturing: true, command: "undo", commandIsActiveOnly: true }),
    ).toBe("command");
  });

  it("does not affect the commands that reach the layer from off", () => {
    // Activation is not active-only; otherwise the layer could never be turned back on.
    expect(
      keyOwner({ ...BASE, capturing: false, command: "toggleAnnotate", commandIsActiveOnly: false }),
    ).toBe("command");
  });
});

describe("safety valves", () => {
  it("are never swallowed by the other state's rules", () => {
    /*
     * `Escape` has no mouse equivalent; trapping it makes a state with no way out. So it is
     * never blocked outright — while active it is *consumed* but keeps its default
     * (`block-keep-default`), which is what lets an open input method cancel.
     */
    expect(keyOwner({ ...BASE, capturing: true, safetyValve: true })).toBe("block-keep-default");
    expect(keyOwner({ ...BASE, capturing: false, safetyValve: true })).toBe("pass");
  });

  it("beats a bound command on the same key", () => {
    expect(
      keyOwner({ ...BASE, capturing: true, safetyValve: true, command: "undo" }),
    ).toBe("block-keep-default");
  });
});

describe("zoom chord", () => {
  it("is not blocked while the layer is active", () => {
    /*
     * Regression: after "active blocks everything it does not recognise", `Ctrl` `+` stopped
     * resizing anything — the key was swallowed before the zoom handler saw it.
     */
    // Consumed (it must not reach Studio) but its default runs, because the handler needs it.
    expect(keyOwner({ ...BASE, capturing: true, zoomChord: true })).toBe("block-keep-default");
  });

  it("is recognised on both the top row and the numpad", () => {
    const base = { ctrlKey: true, metaKey: false, altKey: false };
    expect(isZoomChord({ ...base, key: "=", code: "Equal" })).toBe(true);
    expect(isZoomChord({ ...base, key: "+", code: "Equal" })).toBe(true);
    expect(isZoomChord({ ...base, key: "+", code: "NumpadAdd" })).toBe(true);
    expect(isZoomChord({ ...base, key: "-", code: "Minus" })).toBe(true);
    expect(isZoomChord({ ...base, key: "0", code: "Digit0" })).toBe(true);
  });

  it("is not the zoom chord without a modifier, or with Alt", () => {
    const none = { ctrlKey: false, metaKey: false, altKey: false };
    expect(isZoomChord({ ...none, key: "=", code: "Equal" })).toBe(false);
    const alt = { ctrlKey: true, metaKey: false, altKey: true };
    expect(isZoomChord({ ...alt, key: "=", code: "Equal" })).toBe(false);
  });

  it("does not swallow a plain letter", () => {
    const base = { ctrlKey: true, metaKey: false, altKey: false };
    expect(isZoomChord({ ...base, key: "s", code: "KeyS" })).toBe(false);
  });
});

describe("helpers", () => {
  it("knows the two safety valves by physical code", () => {
    expect(isSafetyValve("Escape")).toBe(true);
    expect(isSafetyValve("Enter")).toBe(true);
    expect(isSafetyValve("KeyA")).toBe(false);
  });

  const modified = { modified: true };
  const unmodified = { modified: false };

  it("knows the Ctrl chords a text field means by itself", () => {
    for (const code of ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ"]) {
      expect(isTextEditingCode(code, modified)).toBe(true);
    }
    expect(isTextEditingCode("KeyS", modified)).toBe(false);
    expect(isTextEditingCode("Digit1", modified)).toBe(false);
  });

  it("does NOT treat a bare letter as an editing chord", () => {
    /*
     * The reported defect: pressing `A` repeatedly in the prompt box made the layer step aside,
     * and the key fell through to Studio, where `A` is the in-point key. A bare letter is text,
     * not a chord — the field types it, nobody else sees it (found.md F-125).
     */
    for (const code of ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ"]) {
      expect(isTextEditingCode(code, unmodified)).toBe(false);
    }
  });

  it("still gives unmodified Backspace and Delete to the field", () => {
    // Deleting a character is typing, so these two are the field's without any modifier.
    expect(isTextEditingCode("Backspace", unmodified)).toBe(true);
    expect(isTextEditingCode("Delete", unmodified)).toBe(true);
  });
});

/**
 * ## The design constraint
 *
 * The two states are **two applications that must never reach each other**. Not "the key looks
 * harmless on the other side" — structurally impossible to interact:
 *
 * > "就算下层对 B 没有反应，B 不应该穿透。跟这到底是什么键没关系。"
 *
 * So in the active state, **every** key is consumed by this layer, whether or not it is bound to
 * a command, and whether or not Studio uses it. A key that happens to be unbound is not an
 * excuse to let it through.
 */
describe("active: every key is consumed, bound or not", () => {
  /*
   * `keyOwner` decides from the **category** a key fell into (command? chord? safety valve?),
   * never from which key it is. That is the property worth stating: the answer for "none of the
   * above" is the same whatever the key happens to be, so no binding table can open a hole by
   * omission (found.md F-125).
   */
  const categories = {
    command: null,
    textEditingChord: false,
    commandYieldsToText: false,
    zoomChord: false,
    safetyValve: false,
  } as const;

  it("consumes a key that is none of the categories", () => {
    expect(keyOwner({ ...BASE, capturing: true, ...categories })).toBe("block");
  });

  it("never answers `pass` while active, for any category", () => {
    /*
     * Exhaustive over the inputs: each is a different category, and none may let the event
     * continue. `pass` exists for the inactive state only.
     */
    const inputs: OwnershipInput[] = [
      { ...BASE, capturing: true, ...categories },
      { ...BASE, capturing: true, command: "undo" },
      { ...BASE, capturing: true, typing: true, textEditingChord: true },
      { ...BASE, capturing: true, zoomChord: true },
      { ...BASE, capturing: true, safetyValve: true },
      { ...BASE, capturing: true, typing: true, commandYieldsToText: true },
    ];
    for (const input of inputs) {
      expect(keyOwner(input)).not.toBe("pass");
    }
  });

  it("consumes a bare letter in the box without stopping it from being typed", () => {
    /*
     * Both halves of the reported defect meet here, and neither may win:
     *
     * - the letter must **not reach Studio** (the original leak: `A` was the in-point key);
     * - the letter must **still be typed** (a text box that eats characters is not a text box).
     *
     * `block-keep-default` is exactly that pair: consumed by this layer, default left alive.
     * The old `pass` gave the second and lost the first; `block` gives the first and loses the
     * second (found.md F-125).
     */
    expect(
      keyOwner({ ...BASE, capturing: true, typing: true, textEditingChord: false }),
    ).toBe("block-keep-default");
  });

  it("gives the same answer for a letter as for an editing chord while typing", () => {
    /*
     * The distinction between "a chord the field reserves" and "an ordinary character" decides
     * *nothing* while the caret is in the box: both are consumed, both keep their default.
     * Letting that distinction drive ownership is what produced the leak.
     */
    expect(keyOwner({ ...BASE, capturing: true, typing: true, textEditingChord: false })).toBe(
      keyOwner({ ...BASE, capturing: true, typing: true, textEditingChord: true }),
    );
  });
});
