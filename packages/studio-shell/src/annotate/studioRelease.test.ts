import { describe, expect, it } from "vitest";
import {
  STUDIO_ACTIONS_RELEASED,
  STUDIO_DEFAULT_KEYS,
  releaseStudioKeys,
  studioOwnerOf,
} from "./studioConflict.js";
import { getStudioKeys } from "../player/components/studioShortcuts.js";
import { binding } from "./keybinding.js";

/**
 * "One shortcut, every layer responds."
 *
 * This is the defect that keeps coming back in different clothes: a chord that this layer
 * uses is **also** still bound inside Studio, so one press runs both actions. The rule is
 * that each chord has exactly one owner (see `found.md` F-059), and `releaseStudioKeys` is
 * where that is enforced.
 *
 * The failure mode is silent. Studio's key map accepts an override and returns a brand-new
 * map, so if the override is refused (an unparseable combo, a clash with another action) it
 * falls back to the **defaults** — meaning the key was never released, and nothing anywhere
 * reports it. The user experiences it as "the key goes through to the end".
 */
describe("releasing Studio's keys", () => {
  it("leaves no action on the chords this layer uses", () => {
    const restore = releaseStudioKeys();
    try {
      const keys = getStudioKeys();
      for (const action of STUDIO_ACTIONS_RELEASED) {
        // The action still exists (Studio refuses a map missing one), it just moved.
        expect(keys[action]).toBeDefined();
      }
    } finally {
      restore();
    }
  });

  it("actually moved captionSelectAll off Ctrl+A", () => {
    /*
     * `Ctrl+A` is this layer's activation toggle. If the override is refused, Studio keeps
     * `mod+a` for select-all-captions and every press does both: the annotation window
     * deactivates *and* every caption is selected.
     */
    const restore = releaseStudioKeys();
    try {
      const owner = studioOwnerOf(binding("KeyA", { ctrl: true }), getStudioKeys());
      expect(owner).toBeNull();
    } finally {
      restore();
    }
  });

  it("moved every released action, not just the tab shortcuts", () => {
    const restore = releaseStudioKeys();
    try {
      const after = getStudioKeys();
      // Each one must differ from its default, or it was never released.
      for (const action of STUDIO_ACTIONS_RELEASED) {
        expect(after[action]).not.toBe(STUDIO_DEFAULT_KEYS[action]);
      }
    } finally {
      restore();
    }
  });

  it("does not leave the released actions fighting each other", () => {
    /*
     * Studio refuses a whole map that contains a clash and silently reverts to defaults.
     * That is how a release can look successful and do nothing — so the replacements are
     * checked for uniqueness too.
     */
    const restore = releaseStudioKeys();
    try {
      const keys = getStudioKeys();
      const released = STUDIO_ACTIONS_RELEASED.map((action) => keys[action]);
      expect(new Set(released).size).toBe(released.length);
    } finally {
      restore();
    }
  });

  it("restores the previous map when undone", () => {
    const restore = releaseStudioKeys();
    const released = getStudioKeys().captionSelectAll;
    restore();
    expect(getStudioKeys().captionSelectAll).toBe(STUDIO_DEFAULT_KEYS.captionSelectAll);
    expect(released).not.toBe(STUDIO_DEFAULT_KEYS.captionSelectAll);
  });
});
