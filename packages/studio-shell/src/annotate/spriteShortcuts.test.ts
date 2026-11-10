import { describe, expect, it } from "vitest";
import { spriteShortcuts, type ShortcutContext } from "./spriteShortcuts.js";
import type { CommandId } from "./commands.js";

/**
 * What the sprite claims works right now.
 *
 * The list is a promise: each row says "press this, here, and that happens". These tests
 * pin the two ways it can lie — printing a key the user has rebound, and describing an
 * action that does not apply on the surface currently showing.
 */

const BASE: ShortcutContext = {
  capturing: false,
  surfaceVisible: true,
  boardMode: false,
  selectionAvailable: false,
  boardHasInk: false,
  canUndo: false,
  canRedo: false,
  hasLiveMarks: false,
  fullscreen: false,
};

/** A recognisable label per command, so a wrong row is obvious in a diff. */
const keyOf = (id: CommandId): string => `KEY:${id}`;
const keys = (context: ShortcutContext): string[] =>
  spriteShortcuts(context, keyOf).map((row) => row.key);

describe("inactive", () => {
  it("offers activation and explains the zoom chord", () => {
    const rows = spriteShortcuts(BASE, keyOf);
    expect(rows[0]?.key).toBe("KEY:toggleAnnotate");
    expect(rows.some((row) => row.key === "Ctrl ±")).toBe(true);
  });

  it("mentions the window toggle only while the window is visible", () => {
    expect(keys(BASE)).toContain("KEY:toggleVisible");
    expect(keys({ ...BASE, surfaceVisible: false })).not.toContain("KEY:toggleVisible");
  });

  it("does not claim drawing tools before the layer owns the input", () => {
    expect(keys(BASE)).not.toContain("KEY:toolRegion");
  });
});

describe("active on the video", () => {
  const active: ShortcutContext = { ...BASE, capturing: true, canUndo: true, hasLiveMarks: true };

  it("lists the five tools with their live bindings", () => {
    expect(keys(active)).toEqual(
      expect.arrayContaining([
        "KEY:toolRegion",
        "KEY:toolArrow",
        "KEY:toolFreehand",
        "KEY:toolEraser",
        "KEY:toolSelect",
      ]),
    );
  });

  it("offers undo and redo only when that stack is non-empty", () => {
    expect(keys(active)).toContain("KEY:undo");
    expect(keys(active)).not.toContain("KEY:redo");
    expect(keys({ ...active, canUndo: false })).not.toContain("KEY:undo");
  });

  it("says 'draw something first' when no mark can be named", () => {
    const row = spriteShortcuts({ ...active, hasLiveMarks: false }, keyOf).find(
      (entry) => entry.key === "KEY:addToPrompt",
    );
    expect(row?.detail).toContain("Draw something first");
  });

  it("takes the binding from the supplied table, never a hard-coded key", () => {
    const rebound = spriteShortcuts(active, () => "Ctrl + J");
    expect(rebound.find((row) => row.label === "Region")?.key).toBe("Ctrl + J");
  });
});

describe("active on the board", () => {
  const board: ShortcutContext = { ...BASE, capturing: true, boardMode: true };

  it("does not claim the timeline turns pages", () => {
    /*
     * The old row said "move the playhead to a different scene; each scene is one page".
     * Pages are the board's own now: nothing about the timeline changes them, and stating
     * otherwise sent the user looking for a control that does not exist.
     */
    const details = spriteShortcuts(board, keyOf).map((row) => row.detail).join(" ");
    expect(details).not.toMatch(/playhead|scene/i);
    expect(keys(board)).not.toContain("Timeline");
  });

  it("never claims 'add the newest mark' on paper", () => {
    const row = spriteShortcuts(board, keyOf).find((entry) => entry.key === "KEY:addToPrompt");
    expect(row?.detail).toMatch(/element|sketch/i);
  });

  it("tracks whether Studio has an element selected", () => {
    const withSelection = spriteShortcuts({ ...board, selectionAvailable: true }, keyOf).find(
      (entry) => entry.key === "KEY:addToPrompt",
    );
    expect(withSelection?.detail).toBe("Adds the selected element to the prompt");
  });

  it("offers board undo only when the page has ink", () => {
    expect(keys(board)).not.toContain("KEY:undo");
    expect(keys({ ...board, boardHasInk: true })).toContain("KEY:undo");
  });
});
