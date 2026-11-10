import { describe, expect, it } from "vitest";
import {
  INITIAL_SURFACE,
  capturesInput,
  setEditorTarget,
  toggleActive,
  toggleEditor,
  toggleVisible,
  type SurfaceState,
} from "./surfaceMode.js";

const shown = (over: Partial<SurfaceState> = {}): SurfaceState => ({
  ...INITIAL_SURFACE,
  visible: true,
  ...over,
});

const hidden = (over: Partial<SurfaceState> = {}): SurfaceState => ({
  ...INITIAL_SURFACE,
  visible: false,
  ...over,
});

describe("toggleVisible (H)", () => {
  it("turns visibility off without touching activation", () => {
    // H is only about presence. The first press flips visible to hidden.
    const next = toggleVisible(INITIAL_SURFACE);
    expect(next).toMatchObject({ visible: false, active: false });
  });

  it("hides and leaves activation untouched", () => {
    // H does not touch activation. Hide then show again and the active state must
    // come back untouched.
    const active = { ...shown(), active: true };
    const hidden = toggleVisible(active);
    expect(hidden).toMatchObject({ visible: false, active: true });
    expect(toggleVisible(hidden)).toMatchObject({ visible: true, active: true });
  });

  it("is a pure toggle", () => {
    expect(toggleVisible(toggleVisible(INITIAL_SURFACE))).toEqual(INITIAL_SURFACE);
  });

  it("reveals a hidden window on the next press", () => {
    expect(toggleVisible(hidden())).toMatchObject({ visible: true });
  });
});

describe("toggleActive (A)", () => {
  it("activating also reveals the window", () => {
    // An invisible window cannot be active; pressing A from hidden must light up both
    // visible and active.
    expect(toggleActive(hidden())).toMatchObject({ visible: true, active: true });
  });

  it("deactivating keeps the window visible, so it can be moved but not clicked", () => {
    const active = toggleActive(INITIAL_SURFACE);
    const off = toggleActive(active);
    expect(off).toMatchObject({ visible: true, active: false });
  });

  it("deactivating closes the editor float", () => {
    const withEditor = toggleEditor(toggleActive(INITIAL_SURFACE));
    expect(withEditor.editorOpen).toBe(true);
    expect(toggleActive(withEditor)).toMatchObject({ active: false, editorOpen: false });
  });
});

describe("capturesInput", () => {
  it("only captures when visible AND active", () => {
    expect(capturesInput(INITIAL_SURFACE)).toBe(false);
    expect(capturesInput(shown())).toBe(false);
    expect(capturesInput(shown({ active: true }))).toBe(true);
    expect(capturesInput({ ...shown({ active: true }), visible: false })).toBe(false);
  });
});

describe("toggleEditor (E)", () => {
  it("does nothing unless active", () => {
    expect(toggleEditor(shown())).toEqual(shown());
    expect(toggleEditor(INITIAL_SURFACE)).toEqual(INITIAL_SURFACE);
  });

  it("toggles inside an active window", () => {
    const active = toggleActive(INITIAL_SURFACE);
    expect(toggleEditor(active)).toMatchObject({ editorOpen: true });
    expect(toggleEditor(toggleEditor(active))).toMatchObject({ editorOpen: false });
  });
});

describe("leaving activation", () => {
  it("is done with A, not Escape", () => {
    /*
     * There is deliberately no Escape-to-deactivate helper: `A` alone toggles
     * activation, and Escape is reserved for cancelling a draft. A `deactivate()`
     * export would invite someone to wire it up and quietly break that rule.
     */
    const active = toggleActive(INITIAL_SURFACE);
    expect(toggleActive(active)).toMatchObject({ visible: true, active: false });
  });

  it("closes the property float when leaving, so no orphan window is left behind", () => {
    const active = toggleEditor(toggleActive(INITIAL_SURFACE));
    expect(active.editorOpen).toBe(true);
    expect(toggleActive(active).editorOpen).toBe(false);
  });
});

describe("setEditorTarget", () => {
  it("records and clears a target", () => {
    expect(setEditorTarget(INITIAL_SURFACE, "#title").editorTarget).toBe("#title");
    expect(setEditorTarget(setEditorTarget(INITIAL_SURFACE, "#title"), null).editorTarget).toBeNull();
  });

  it("returns the same object for an unchanged target", () => {
    const state = setEditorTarget(INITIAL_SURFACE, "#title");
    expect(setEditorTarget(state, "#title")).toBe(state);
  });
});
