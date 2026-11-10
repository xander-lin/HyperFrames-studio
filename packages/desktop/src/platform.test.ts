import { describe, expect, it } from "vitest";
import {
  chooseOzonePlatform,
  inputMethodEnvPatch,
  isXwayland,
  requestedPlatform,
  type SessionEnv,
} from "./platform.js";

/**
 * Backend selection.
 *
 * The reason these are tests and not a paragraph in a comment: the previous decision was a
 * hard-coded flag justified by a claim that turned out to be false ("Wayland + Vulkan does not
 * start"). Once a claim like that is only prose, nothing can contradict it. These tests can.
 */

const wayland: SessionEnv = { sessionType: "wayland", waylandDisplay: "wayland-1", display: ":0" };
const x11Only: SessionEnv = { sessionType: "x11", display: ":0" };

describe("requestedPlatform", () => {
  it("reads the joined form", () => {
    expect(requestedPlatform(["--ozone-platform=wayland"])).toBe("wayland");
  });

  it("reads the split form", () => {
    expect(requestedPlatform(["--ozone-platform", "x11"])).toBe("x11");
  });

  it("ignores unrelated arguments", () => {
    expect(requestedPlatform([".", "/tmp/project", "--no-sandbox"])).toBeUndefined();
  });

  it("treats an empty value as absent rather than as a choice", () => {
    expect(requestedPlatform(["--ozone-platform="])).toBeUndefined();
    expect(requestedPlatform(["--ozone-platform", "--no-sandbox"])).toBeUndefined();
  });
});

describe("chooseOzonePlatform", () => {
  it("picks Wayland when a Wayland display is reachable", () => {
    expect(chooseOzonePlatform(wayland)).toBe("wayland");
  });

  it("picks Wayland even if the session variable disagrees, because the display is the fact", () => {
    expect(chooseOzonePlatform({ sessionType: "tty", waylandDisplay: "wayland-1" })).toBe("wayland");
  });

  it("picks X11 when only DISPLAY exists", () => {
    expect(chooseOzonePlatform(x11Only)).toBe("x11");
  });

  it("leaves Electron alone when neither exists", () => {
    expect(chooseOzonePlatform({})).toBeNull();
  });

  it("never overrides an explicit flag", () => {
    expect(chooseOzonePlatform({ ...wayland, requested: "x11" })).toBeNull();
    expect(chooseOzonePlatform({ ...x11Only, requested: "wayland" })).toBeNull();
  });

  it("treats a blank WAYLAND_DISPLAY as absent", () => {
    expect(chooseOzonePlatform({ waylandDisplay: "  ", display: ":0" })).toBe("x11");
  });
});

describe("isXwayland", () => {
  it("is true for x11 on a Wayland session", () => {
    expect(isXwayland("x11", wayland)).toBe(true);
  });

  it("is false for a native Wayland window", () => {
    expect(isXwayland("wayland", wayland)).toBe(false);
  });

  it("is false for a real X11 session", () => {
    expect(isXwayland("x11", x11Only)).toBe(false);
  });

  it("is false when Electron chose for itself", () => {
    expect(isXwayland(null, wayland)).toBe(false);
  });
});

describe("inputMethodEnvPatch", () => {
  it("adds XIM for an XWayland client with an empty environment", () => {
    expect(inputMethodEnvPatch("x11", wayland, {})).toEqual({
      XMODIFIERS: "@im=fcitx",
      GTK_IM_MODULE: "fcitx5",
    });
  });

  it("adds nothing on native Wayland, where the text-input protocol already works", () => {
    /*
     * This is the regression guard. Measured with fcitx's input-context list, forcing
     * GTK_IM_MODULE=fcitx5 on a native Wayland window left the app at `focus:0`, while the
     * untouched environment reached `focus:1` over `wayland_v2`. Adding the variable would be
     * "helping" in a way that breaks the thing it is meant to help.
     */
    expect(inputMethodEnvPatch("wayland", wayland, {})).toEqual({});
  });

  it("adds nothing on a plain X11 session", () => {
    expect(inputMethodEnvPatch("x11", x11Only, {})).toEqual({});
  });

  it("adds nothing when Electron chose the backend itself", () => {
    expect(inputMethodEnvPatch(null, wayland, {})).toEqual({});
  });

  it("keeps a deliberate XMODIFIERS", () => {
    expect(inputMethodEnvPatch("x11", wayland, { XMODIFIERS: "@im=ibus" })).toEqual({
      GTK_IM_MODULE: "fcitx5",
    });
  });

  it("keeps a deliberate GTK_IM_MODULE", () => {
    expect(inputMethodEnvPatch("x11", wayland, { GTK_IM_MODULE: "gtk-im-context-simple" })).toEqual({
      XMODIFIERS: "@im=fcitx",
    });
  });

  it("treats a blank value as unset", () => {
    expect(inputMethodEnvPatch("x11", wayland, { XMODIFIERS: " ", GTK_IM_MODULE: "" })).toEqual({
      XMODIFIERS: "@im=fcitx",
      GTK_IM_MODULE: "fcitx5",
    });
  });
});
