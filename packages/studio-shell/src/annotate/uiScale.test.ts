import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLayerScale,
  applyStudioScale,
  handleZoomKey,
  layoutViewport,
  readUiScale,
  restoreUiScale,
  studioUiScale,
  uiScale,
  zoomIn,
  zoomOut,
  zoomReset,
  zoomTargetFor,
} from "./uiScale.js";

/**
 * Two interfaces, two scales.
 *
 * Studio's editor and this annotation layer resize **independently**. They have different
 * needs (a readable timeline versus a toolbar big enough to hit over footage), so one chord
 * goes to whichever surface currently owns the input — the same rule `A` already follows.
 *
 * These tests pin that separation, because the tempting simplification is to scale both at
 * once, which is exactly what was wrong.
 */

function installFakeDom(): void {
  const style = new Map<string, string>();
  const store = new Map<string, string>();

  const documentElement = {
    style: {
      get fontSize() {
        return style.get("fontSize") ?? "";
      },
      set fontSize(value: string) {
        style.set("fontSize", value);
      },
      setProperty: (name: string, value: string) => style.set(name, value),
      getPropertyValue: (name: string) => style.get(name) ?? "",
    },
  };

  vi.stubGlobal("document", { documentElement });
  vi.stubGlobal("window", {
    innerWidth: 1000,
    innerHeight: 800,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
}

function zoomEvent(over: { key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
  return {
    key: over.key ?? "",
    code: over.code ?? "",
    ctrlKey: over.ctrlKey ?? false,
    metaKey: over.metaKey ?? false,
    altKey: over.altKey ?? false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installFakeDom();
  applyStudioScale(1);
  applyLayerScale(1);
});

describe("the two scales are independent", () => {
  it("scaling the layer leaves Studio alone", () => {
    /*
     * The requirement, stated as a test: enlarging the toolbar must not reflow the editor
     * underneath it.
     */
    applyStudioScale(1);
    applyLayerScale(1.5);
    expect(uiScale()).toBe(1.5);
    expect(studioUiScale()).toBe(1);
    expect(document.documentElement.style.fontSize).toBe("16px");
  });

  it("scaling Studio leaves the layer alone", () => {
    applyLayerScale(1);
    applyStudioScale(1.25);
    expect(studioUiScale()).toBe(1.25);
    expect(uiScale()).toBe(1);
    expect(document.documentElement.style.fontSize).toBe("20px");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.25");
  });

  it("remembers the two choices under different keys", () => {
    applyStudioScale(1.25);
    applyLayerScale(1.5);
    expect(window.localStorage.getItem("mystudio:ui-scale")).toBe("1.25");
    expect(window.localStorage.getItem("mystudio:layer-scale")).toBe("1.5");
  });

  it("restores both at startup", () => {
    window.localStorage.setItem("mystudio:ui-scale", "1.25");
    window.localStorage.setItem("mystudio:layer-scale", "1.5");
    restoreUiScale();
    expect(studioUiScale()).toBe(1.25);
    expect(uiScale()).toBe(1.5);
  });
});

describe("the chord goes to whoever owns the input", () => {
  it("resizes the layer while annotating", () => {
    expect(zoomTargetFor(true)).toBe("layer");
  });

  it("resizes Studio while not annotating", () => {
    expect(zoomTargetFor(false)).toBe("studio");
  });

  it("only touches the chosen surface", () => {
    handleZoomKey(zoomEvent({ key: "=", code: "Equal", ctrlKey: true }), "layer");
    expect(uiScale()).toBe(1.1);
    expect(studioUiScale()).toBe(1);

    handleZoomKey(zoomEvent({ key: "=", code: "Equal", ctrlKey: true }), "studio");
    expect(uiScale()).toBe(1.1);
    expect(studioUiScale()).toBe(1.1);
  });
});

describe("zoom steps", () => {
  it("steps up through the ladder and stops at the top", () => {
    applyStudioScale(1);
    expect(zoomIn("studio")).toBe(1.1);
    expect(zoomIn("studio", 2)).toBe(2);
  });

  it("steps down and stops at the bottom", () => {
    applyStudioScale(1);
    expect(zoomOut("studio")).toBe(0.9);
    expect(zoomOut("studio", 0.8)).toBe(0.8);
  });

  it("resets the target to 100%", () => {
    applyStudioScale(1.75);
    applyLayerScale(1.5);
    expect(zoomReset("studio")).toBe(1);
    expect(studioUiScale()).toBe(1);
    // The other surface kept its own value.
    expect(uiScale()).toBe(1.5);
  });

  it("snaps an unknown value onto the nearest step instead of drifting", () => {
    applyStudioScale(1.13);
    // 1.13 is nearest 1.1, so one step up should reach 1.25.
    expect(zoomIn("studio", 1.13)).toBe(1.25);
  });
});

describe("readUiScale", () => {
  it("defaults to 1 for both surfaces when nothing is stored", () => {
    expect(readUiScale("studio")).toBe(1);
    expect(readUiScale("layer")).toBe(1);
  });

  it("ignores a junk stored value", () => {
    window.localStorage.setItem("mystudio:ui-scale", "banana");
    restoreUiScale();
    expect(studioUiScale()).toBe(1);
  });
});

describe("layoutViewport", () => {
  it("reports the window divided by the layer's scale", () => {
    /*
     * The overlay is laid out in **unscaled** units inside a scaled container, so at 200%
     * it has half the window's width to work with. Using the raw window size would let a
     * tool believe it has room it does not.
     */
    applyLayerScale(2);
    expect(layoutViewport()).toEqual({ width: 500, height: 400 });
  });

  it("is the window size at 100%", () => {
    applyLayerScale(1);
    expect(layoutViewport()).toEqual({ width: 1000, height: 800 });
  });

  it("ignores Studio's scale", () => {
    applyStudioScale(1.5);
    applyLayerScale(1);
    expect(layoutViewport()).toEqual({ width: 1000, height: 800 });
  });
});

describe("handleZoomKey", () => {
  it("zooms in on Ctrl and the equals key", () => {
    const event = zoomEvent({ key: "=", code: "Equal", ctrlKey: true });
    expect(handleZoomKey(event, "studio")).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(studioUiScale()).toBe(1.1);
  });

  it("zooms in on the numpad plus and on Cmd", () => {
    expect(handleZoomKey(zoomEvent({ key: "+", code: "NumpadAdd", metaKey: true }), "studio")).toBe(true);
    expect(studioUiScale()).toBe(1.1);
  });

  it("zooms out on the minus key", () => {
    expect(handleZoomKey(zoomEvent({ key: "-", code: "Minus", ctrlKey: true }), "studio")).toBe(true);
    expect(studioUiScale()).toBe(0.9);
  });

  it("resets on Ctrl+0", () => {
    applyStudioScale(1.5);
    expect(handleZoomKey(zoomEvent({ key: "0", code: "Digit0", ctrlKey: true }), "studio")).toBe(true);
    expect(studioUiScale()).toBe(1);
  });

  it("ignores the same keys without a modifier, so plain typing still works", () => {
    // Without Ctrl, `-` must stay an ordinary character (typed into the prompt, say).
    const event = zoomEvent({ key: "-", code: "Minus" });
    expect(handleZoomKey(event, "studio")).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores other Ctrl combos, leaving them to Studio", () => {
    expect(handleZoomKey(zoomEvent({ key: "z", code: "KeyZ", ctrlKey: true }), "studio")).toBe(false);
  });
});
