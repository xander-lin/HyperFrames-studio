import { describe, expect, it } from "vitest";
import { projectFromArgv } from "./projectArgv.js";

/**
 * Reading the project from argv.
 *
 * ## Why these exist
 *
 * The same defect shipped twice because this logic lived inside `main.ts`, which imports
 * `electron`: untestable, so untested. First `electron .` opened the app's own directory; then,
 * after installing, `electron /install/app` opened the **install tree** as if it were the user's
 * project. Both were the same mistake — deciding which argument is the project by how it is
 * spelled (found.md F-013, F-131).
 *
 * So the cases below are the two launch shapes, spelled out, and the rule is checked against a
 * fact (the app path) rather than against a name.
 */

/** A filesystem where only the listed paths are directories. */
function fakeFs(directories: readonly string[]) {
  const set = new Set(directories);
  return {
    isDirectory: (path: string) => set.has(path),
    resolvePath: (path: string) => (path.startsWith("/") ? path : `/cwd/${path}`),
  };
}

const INSTALL = "/opt/mystudio/app";

describe("installed launch", () => {
  const fs = fakeFs([INSTALL, "/home/me/deck-avl"]);

  it("does not mistake the install tree for the project", () => {
    /*
     * This is the shipped defect: the app opened its own `resources` as a project. It reads as a
     * packaging bug — the window shows nothing — rather than as an argument bug.
     */
    const picked = projectFromArgv(
      ["/install/electron", INSTALL, "/home/me/deck-avl", "--no-sandbox"],
      { appPath: INSTALL, ...fs },
    );
    expect(picked).toBe("/home/me/deck-avl");
  });

  it("returns null when only the install tree was given", () => {
    // Then the app should ask which project to open, not open itself.
    const picked = projectFromArgv([INSTALL, "--no-sandbox"], { appPath: INSTALL, ...fs });
    expect(picked).toBeNull();
  });
});

describe("development launch", () => {
  const fs = fakeFs(["/cwd", "/home/me/deck-avl"]);

  it("skips the `.` app path", () => {
    const picked = projectFromArgv([".", "/home/me/deck-avl", "--no-sandbox"], {
      appPath: ".",
      ...fs,
    });
    expect(picked).toBe("/home/me/deck-avl");
  });

  it("skips the entry script", () => {
    const picked = projectFromArgv([".", "main.js", "/home/me/deck-avl"], {
      appPath: ".",
      ...fs,
    });
    expect(picked).toBe("/home/me/deck-avl");
  });
});

describe("arguments that are not a project", () => {
  it("skips a switch and its value, so a folder named like a backend is not opened", () => {
    // `--ozone-platform wayland` must not open a directory called `wayland`.
    const fs = fakeFs(["/cwd/wayland", "/home/me/deck-avl"]);
    const picked = projectFromArgv(
      ["--ozone-platform", "wayland", "/home/me/deck-avl"],
      { appPath: ".", ...fs },
    );
    expect(picked).toBe("/home/me/deck-avl");
  });

  it("ignores a path that does not exist", () => {
    const fs = fakeFs(["/home/me/deck-avl"]);
    const picked = projectFromArgv(["/typo/deck", "/home/me/deck-avl"], { appPath: ".", ...fs });
    expect(picked).toBe("/home/me/deck-avl");
  });

  it("returns null when nothing usable was given", () => {
    expect(projectFromArgv([], { appPath: "." })).toBeNull();
    expect(projectFromArgv(["--no-sandbox"], { appPath: "." })).toBeNull();
  });
});
