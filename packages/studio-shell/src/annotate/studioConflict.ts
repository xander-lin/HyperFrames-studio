/**
 * What happens when **someone else already owns a key**.
 *
 * ## The bug this module exists to prevent
 *
 * `Ctrl+1` switched our tool to Region *and* activated Studio's Compositions tab. Both
 * actions ran for one press. The naive reading is "we forgot to block the event", and
 * the naive fix is `stopImmediatePropagation()`.
 *
 * That fix does not work, and understanding why is the point of this file:
 *
 * `stopImmediatePropagation()` stops **listeners that have not run yet**. On the same
 * target and phase, listeners run in registration order. Studio registers its hotkey
 * listener once, early; our policy re-registers whenever the preview iframe changes. So
 * after the first iframe load, Studio's listener is *ahead* of ours — it has already
 * activated the tab by the time our handler runs, and no amount of stopping can undo it.
 *
 * Ordering cannot be relied on. Two things actually work, and this module does both:
 *
 * 1. **Do not compete.** Ask Studio which keys it owns, and refuse to bind them. A
 *    shortcut system that silently loses half of every press is worse than one with
 *    fewer keys.
 * 2. **Say so.** The Keys panel reports the collision by name, so "why is Ctrl+1 not
 *    here" is answered in the interface instead of being discovered by watching two
 *    things happen at once.
 *
 * ## Why it also releases the keys at runtime
 *
 * For keys Studio binds that we must not use (the tab shortcuts), the robust answer is
 * not to fight for the event but to make Studio stop listening for it. `releaseKeys`
 * removes those actions from Studio's map, so there is exactly **one** owner of each
 * combination. Where that is not possible — an upstream key we cannot unset — the key is
 * reported as unusable and left unbound on our side.
 */

import { DEFAULT_STUDIO_KEYS, getStudioKeys, setStudioKeys, type StudioKeyAction } from "../player/components/studioShortcuts.js";
import { comboClashKey, parseCombo } from "../player/components/studioCombo.js";
import type { KeyBinding } from "./keybinding.js";

/**
 * Studio actions whose keys this layer deliberately takes over.
 *
 * The tab shortcuts are the known case: `Ctrl+1` / `Ctrl+2` are how Studio switches to
 * Compositions / Assets, but a tool switch on the same chord is what a drawing app wants
 * and what this project's own shortcut table documented. Taking them means **removing**
 * them from Studio, not sharing them.
 */
export const STUDIO_ACTIONS_RELEASED = [
  /*
   * Only chords this layer **genuinely occupies while inactive** belong here.
   *
   * The list used to be much longer — undo/redo, the tab shortcuts, the razor tool — from a
   * time when the layer had no reliable way to block a key. It does now: a capture listener
   * installed before Studio's swallows everything while active, and passes everything while
   * inactive. Releasing a key on top of that is not "extra safety", it is damage: Studio's
   * undo was moved off `Ctrl+Z` permanently, so with the layer inactive `Ctrl+Z` reached
   * nothing at all — not Studio's undo, not the text field's (found.md F-096).
   *
   * `captionSelectAll` stays because the clash is real and permanent: this layer's
   * activation toggle is `Ctrl+A` and it works while inactive, so someone has to give way.
   */
  "captionSelectAll",
] as const satisfies readonly StudioKeyAction[];

/**
 * The clash key for one of our bindings, in Studio's own format.
 *
 * Both sides are normalised through `comboClashKey`, which already treats `mod` (Cmd) and
 * `Ctrl` as the same thing — the same rule Studio uses internally. Comparing our
 * `KeyBinding` against Studio's text directly would miss `mod+1` versus `Ctrl+1`.
 */
function ourClashKey(binding: KeyBinding): string {
  const key =
    /^Digit[0-9]$/.test(binding.code)
      ? binding.code.slice(5)
      : /^Key[A-Z]$/.test(binding.code)
        ? binding.code.slice(3).toLowerCase()
        : binding.code;
  return [binding.ctrl || binding.meta, binding.alt, binding.shift, key.toLowerCase()].join("|");
}

function studioClashKey(combo: string): string | null {
  const parsed = parseCombo(combo);
  return parsed ? comboClashKey(parsed) : null;
}

/** A Studio action whose key is the same physical combination, or null. */
export function studioOwnerOf(
  binding: KeyBinding,
  keys: Readonly<Record<string, string>> = getStudioKeys(),
): StudioKeyAction | null {
  const wanted = ourClashKey(binding);
  for (const [action, combo] of Object.entries(keys)) {
    if (studioClashKey(combo) === wanted) return action as StudioKeyAction;
  }
  return null;
}

/**
 * Human-readable name for a Studio action, for the message shown in the Keys panel.
 *
 * Statements like "tabCompositions already uses Ctrl+1" are true and useless. The user
 * needs to know it is the Compositions tab, because that is the thing they saw change.
 */
export function describeStudioAction(action: StudioKeyAction): string {
  const names: Partial<Record<StudioKeyAction, string>> = {
    tabCompositions: "Studio's Compositions tab",
    tabAssets: "Studio's Assets tab",
    undo: "Studio's undo",
    redo: "Studio's redo",
    redoAlt: "Studio's redo",
    playPause: "Studio's play/pause",
    fullscreen: "Studio's fullscreen",
    split: "Studio's split",
    record: "Studio's record gesture",
    addKeyframe: "Studio's add keyframe",
    zoomSelection: "Studio's zoom to selection",
    selectTool: "Studio's select tool",
    razorTool: "Studio's razor tool",
    group: "Studio's group",
    ungroup: "Studio's ungroup",
    copy: "the clipboard (copy)",
    paste: "the clipboard (paste)",
    cut: "the clipboard (cut)",
    duplicate: "Studio's duplicate",
    loop: "Studio's loop",
    mute: "Studio's mute",
    captionSelectAll: "Studio's select all",
    linkToggle: "Studio's link toggle",
  };
  return names[action] ?? `Studio's ${action}`;
}

/**
 * Remove our keys from Studio's map, returning a restore function.
 *
 * Studio's key map is a module-level value with a setter, so this is a real handover: after
 * it runs there is one owner of the chord, and no event-ordering trick is needed.
 *
 * An action left with no replacement is a genuine problem — Studio refuses a map with a
 * clash and a map missing an action — so the two tab actions are re-pointed at chords we
 * do not use rather than deleted. They stay reachable, just somewhere else.
 */
export function releaseStudioKeys(): () => void {
  const before = getStudioKeys();
  const next: Record<string, string> = { ...before };

  /*
   * Where the released action goes.
   *
   * Moving it is not cosmetic: leaving `captionSelectAll` on `Ctrl+A` while this layer also
   * uses `Ctrl+A` recreates the exact bug — one press, two actions.
   */
  const replacements: Partial<Record<StudioKeyAction, string>> = {
    /*
     * Select-all-captions moves to `Shift+Ctrl+A`: still "select every caption", on a chord
     * this layer does not use. `Ctrl+Alt+A` is not an option — Studio refuses `ctrl+alt`
     * because Windows sends AltGr as Ctrl+Alt.
     */
    captionSelectAll: "shift+mod+a",
  };

  for (const action of STUDIO_ACTIONS_RELEASED) {
    const replacement = replacements[action];
    if (replacement) next[action] = replacement;
  }

  setStudioKeys(next);
  return () => setStudioKeys(before);
}

/** Whether a binding collides with anything Studio owns. */
export function studioConflict(
  binding: KeyBinding,
  keys: Readonly<Record<string, string>> = getStudioKeys(),
): string | null {
  const owner = studioOwnerOf(binding, keys);
  return owner ? describeStudioAction(owner) : null;
}

/** The Studio defaults, exported for tests that must not depend on live state. */
export const STUDIO_DEFAULT_KEYS = DEFAULT_STUDIO_KEYS;
