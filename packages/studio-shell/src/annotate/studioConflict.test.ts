import { afterEach, describe, expect, it } from "vitest";
import { binding } from "./keybinding.js";
import {
  describeStudioAction,
  releaseStudioKeys,
  studioConflict,
  studioOwnerOf,
  STUDIO_DEFAULT_KEYS,
} from "./studioConflict.js";
import { getStudioKeys, setStudioKeys } from "../player/components/studioShortcuts.js";

/**
 * Key ownership between this layer and Studio.
 *
 * The bug: `Ctrl+1` switched our tool **and** activated Studio's Compositions tab. Both
 * ran, because `stopImmediatePropagation` cannot stop a listener that already ran — and
 * Studio's listener is registered first.
 *
 * So the rule these tests protect is not "we win the event" but "**there is only one
 * owner**": either we do not bind the key, or Studio no longer binds it. Anything else
 * means a press does two things, and the user cannot tell which one they asked for.
 */

afterEach(() => {
  // Leave the real map as we found it; the module is shared process-wide.
  setStudioKeys(null);
});

describe("studioOwnerOf", () => {
  it("finds the Studio action on Ctrl+1", () => {
    // The exact conflict observed on the real app.
    expect(studioOwnerOf(binding("Digit1", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBe(
      "tabCompositions",
    );
  });

  it("finds the Studio action on Ctrl+2", () => {
    expect(studioOwnerOf(binding("Digit2", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBe("tabAssets");
  });

  it("treats Cmd on macOS the same as Ctrl", () => {
    // Studio stores the shortcut as `mod+1`, where `mod` means Cmd or Ctrl. Comparing the
    // raw strings would report "no conflict" on macOS and reproduce the bug there only.
    expect(studioOwnerOf(binding("Digit1", { meta: true }), STUDIO_DEFAULT_KEYS)).toBe(
      "tabCompositions",
    );
  });

  it("does not confuse Ctrl+1 with Ctrl+Shift+1", () => {
    expect(studioOwnerOf(binding("Digit1", { ctrl: true, shift: true }), STUDIO_DEFAULT_KEYS)).toBeNull();
  });

  it("reports nothing for a key Studio does not use", () => {
    expect(studioOwnerOf(binding("Digit3", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBeNull();
  });

  it("sees letters as well as digits", () => {
    expect(studioOwnerOf(binding("KeyZ", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBe("undo");
    expect(studioOwnerOf(binding("KeyG", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBe("group");
  });
});

describe("describeStudioAction", () => {
  it("names the thing the user actually sees change", () => {
    /*
     * "tabCompositions already uses Ctrl+1" is true and useless. The user saw a tab
     * switch; the message has to say that, or it does not explain what happened.
     */
    expect(describeStudioAction("tabCompositions")).toContain("Compositions");
    expect(describeStudioAction("tabAssets")).toContain("Assets");
  });

  it("falls back to a readable form for an action it has no copy for", () => {
    expect(describeStudioAction("someFutureAction" as never)).toContain("someFutureAction");
  });
});

describe("studioConflict", () => {
  it("returns a message naming the owner", () => {
    const message = studioConflict(binding("Digit1", { ctrl: true }), STUDIO_DEFAULT_KEYS);
    expect(message).toContain("Compositions");
  });

  it("returns null when the key is free", () => {
    expect(studioConflict(binding("Digit3", { ctrl: true }), STUDIO_DEFAULT_KEYS)).toBeNull();
  });
});

describe("releaseStudioKeys", () => {
  it("leaves Studio's own chords alone when this layer is not using them", () => {
    /*
     * The rule that replaced a wide reshuffle. This layer blocks keys by **state**, not by
     * taking them away from Studio: active, it swallows everything; inactive, it passes
     * everything. So Studio keeps its undo, its tabs and its razor tool where the user
     * already knows them.
     *
     * Releasing them anyway is what broke `Ctrl+Z` while inactive: Studio's undo had been
     * moved to `Alt+Z`, so the chord reached nothing at all (found.md F-096).
     */
    releaseStudioKeys();
    const keys = getStudioKeys();
    expect(keys.undo).toBe(STUDIO_DEFAULT_KEYS.undo);
    expect(keys.redo).toBe(STUDIO_DEFAULT_KEYS.redo);
    expect(keys.tabCompositions).toBe(STUDIO_DEFAULT_KEYS.tabCompositions);
    expect(keys.tabAssets).toBe(STUDIO_DEFAULT_KEYS.tabAssets);
    expect(keys.razorTool).toBe(STUDIO_DEFAULT_KEYS.razorTool);
  });

  it("moves only the one chord this layer really occupies while inactive", () => {
    /*
     * `Ctrl+A` activates the layer while inactive, so it is the single genuine, permanent
     * clash. Everything else is decided at runtime by activation, not by relocation.
     */
    releaseStudioKeys();
    const keys = getStudioKeys();
    expect(keys.captionSelectAll).not.toBe(STUDIO_DEFAULT_KEYS.captionSelectAll);
    // Still reachable — the action must not become unreachable.
    expect(keys.captionSelectAll.length).toBeGreaterThan(0);
    expect(studioOwnerOf(binding("KeyA", { ctrl: true }))).toBeNull();
  });

  it("keeps Ctrl+Z available to Studio, so undo works while inactive", () => {
    // The reported symptom: inactive, `Ctrl+Z` did nothing at all.
    releaseStudioKeys();
    expect(studioOwnerOf(binding("KeyZ", { ctrl: true }))).toBe("undo");
    expect(studioOwnerOf(binding("KeyZ", { ctrl: true, shift: true }))).toBe("redo");
  });

  it("moves only the actions it actually collides with", () => {
    /*
     * A wide reshuffle would break muscle memory for keys this layer never needed. The
     * list is short and each entry is a real collision with our own table — see
     * `STUDIO_ACTIONS_RELEASED`.
     */
    releaseStudioKeys();
    const keys = getStudioKeys();
    expect(keys.copy).toBe(STUDIO_DEFAULT_KEYS.copy);
    expect(keys.paste).toBe(STUDIO_DEFAULT_KEYS.paste);
    expect(keys.playPause).toBe(STUDIO_DEFAULT_KEYS.playPause);
    expect(keys.split).toBe(STUDIO_DEFAULT_KEYS.split);
  });

  it("is reversible, so the layer can be torn down cleanly", () => {
    const restore = releaseStudioKeys();
    restore();
    expect(getStudioKeys().tabCompositions).toBe(STUDIO_DEFAULT_KEYS.tabCompositions);
  });
});
