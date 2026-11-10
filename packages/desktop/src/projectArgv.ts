import { statSync } from "node:fs";

/**
 * Reading the project directory out of the command line.
 *
 * ## Why this is its own module
 *
 * It was a private function inside `main.ts`, which imports `electron` — so it could not be
 * tested without launching a window, and in practice it was not tested at all. That is how the
 * same defect shipped twice:
 *
 * 1. in development, `electron .` puts `.` in argv and `.` was taken as the project;
 * 2. **after installing**, `electron /install/app` puts an absolute directory there, which no
 *    amount of "skip `.` and `.js`" can recognise — the app opened its own install tree as if it
 *    were the user's project (found.md F-013, F-131).
 *
 * Both are the same mistake: guessing which argument is which from how it is *spelled*. The rule
 * now is to compare against a **fact** — the directory Electron actually loaded — which the
 * caller supplies.
 */

/** What the argv reader needs to know about the host. */
export interface ArgvContext {  /**
   * The directory Electron loaded, i.e. `app.getAppPath()`.
   *
   * Required rather than optional: an optional field is one a caller can forget, and forgetting
   * it is exactly how the installed form regressed.
   */
  readonly appPath: string;
  /** Whether a path exists and is a directory. Injected so tests need no real filesystem. */
  readonly isDirectory?: (path: string) => boolean;
  /** Absolute-path resolution. Injected for the same reason. */
  readonly resolvePath?: (path: string) => string;
}

const DEFAULT_RESOLVE = (path: string): string => path;

/**
 * The project directory named on the command line, or `null` when none was.
 *
 * Arguments are skipped when they are:
 *
 * - **switches** (`-…`), with the value of `--ozone-platform` skipped too — it is a backend name,
 *   not a path, and a folder called `wayland` must not be mistaken for a project;
 * - **`.` / `..`** — the development app path, meaningless as a project;
 * - **script files** (`*.js` / `*.mjs` / `*.cjs`) — the entry point, not a project;
 * - **the app's own directory** — the installed app path. Compared resolved, so `.` and the
 *   absolute form agree.
 *
 * The first remaining argument that is an existing directory wins. Anything else is ignored
 * rather than rejected, because Electron and the desktop environment inject their own arguments
 * and a stricter rule would break launching from a file manager.
 */
export function projectFromArgv(
  argv: readonly string[],
  context: ArgvContext,
): string | null {
  const resolvePath = context.resolvePath ?? DEFAULT_RESOLVE;
  const isDirectory = context.isDirectory ?? defaultIsDirectory;
  const appPath = context.appPath ? resolvePath(context.appPath) : "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.startsWith("-")) {
      if (arg === "--ozone-platform") index += 1;
      continue;
    }
    if (arg === "." || arg === "..") continue;
    if (arg.endsWith(".js") || arg.endsWith(".mjs") || arg.endsWith(".cjs")) continue;

    const candidate = resolvePath(arg);
    if (appPath && candidate === appPath) continue;
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/** The real filesystem, kept out of the module's import graph for testability. */
function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
