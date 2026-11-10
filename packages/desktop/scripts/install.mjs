/**
 * Build an installable copy of MyStudio, without electron-builder.
 *
 * ## Why not electron-builder
 *
 * It is a large dependency that produces a self-extracting installer for a specific
 * distribution. What this app actually needs is: **the Electron runtime, our bundle, and a
 * launcher** that knows where both are. That is four steps and no third-party tool, and it keeps
 * the result inspectable — if the install misbehaves, every file in it is one we wrote.
 *
 * ## What "installed" has to mean
 *
 * The install must not depend on this repository. After it is finished:
 *
 * - the launcher can be called from anywhere (it resolves its own location, not the cwd);
 * - the app reads the Studio build from its own `resources/`, not from `packages/desktop`;
 * - passing a project directory works exactly as in development.
 *
 * ## Layout of the installed tree
 *
 * ```
 * <prefix>/
 *   mystudio                     launcher (executable shell script)
 *   app/
 *     package.json               name + main, so Electron treats it as an app
 *     dist/main.js               the bundled main process (workspace deps inlined)
 *     dist/studio/               the Studio build the window loads
 *   electron/                    the Electron runtime, unmodified
 * ```
 *
 * The Electron runtime is copied rather than symlinked: a symlink into a pnpm store breaks the
 * moment that store is pruned or the repository moves, and the point of installing is to stop
 * depending on both.
 */

import { cp, mkdir, readFile, rm, writeFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

/** Where the installed tree goes. `--prefix` overrides. */
const prefixArg = process.argv.find((arg) => arg.startsWith("--prefix="));
const prefix = prefixArg
  ? resolve(prefixArg.slice("--prefix=".length))
  : resolve(repoRoot, "release");

function require_(value, what) {
  if (!existsSync(value)) {
    throw new Error(`Cannot build the install: ${what} is missing at ${value}`);
  }
  return value;
}

/** Resolve the Electron runtime distribution shipped by the `electron` package. */
async function electronDist() {
  const pkgPath = require_(
    join(repoRoot, "node_modules", ".pnpm"),
    "the pnpm store",
  );
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(pkgPath);
  /*
   * Several copies of the `electron` package exist (one per peer-dependency variant). Any of
   * them contains the same binary, so the first one with a `dist/` is used rather than pinning an
   * exact directory name — pinning would break on a version bump for no benefit.
   */
  for (const entry of entries) {
    if (!entry.startsWith("electron@")) continue;
    const candidate = join(pkgPath, entry, "node_modules", "electron", "dist");
    if (existsSync(join(candidate, "electron"))) return candidate;
  }
  throw new Error("Cannot build the install: the Electron runtime is not in the pnpm store");
}

async function main() {
  const dist = await electronDist();
  const mainBundle = require_(join(desktopRoot, "dist", "main.js"), "the bundled main process");
  /*
   * The **directory** is what gets copied. `require_` takes the `index.html` only to prove the
   * build is present and complete — passing that path into `cp` would copy one file and then
   * fail with a message about a missing `index.html`, which reads like a packaging bug rather
   * than the wrong variable.
   */
  const studio = require_(join(desktopRoot, "dist", "studio"), "the Studio build");
  require_(join(studio, "index.html"), "the Studio build's entry page");

  console.log(`[install] prefix  ${prefix}`);
  console.log(`[install] electron ${dist}`);

  /*
   * Rebuild from scratch. A half-replaced tree is worse than none: the launcher would run a
   * mixture of two versions and the failure would look like an app bug.
   */
  await rm(prefix, { recursive: true, force: true });
  await mkdir(join(prefix, "app", "dist"), { recursive: true });

  console.log("[install] copying the Electron runtime…");
  await cp(dist, join(prefix, "electron"), { recursive: true, verbatimSymlinks: false });

  console.log("[install] copying the app…");
  await cp(mainBundle, join(prefix, "app", "dist", "main.js"));
  const mapPath = join(desktopRoot, "dist", "main.js.map");
  if (existsSync(mapPath)) await cp(mapPath, join(prefix, "app", "dist", "main.js.map"));
  /*
   * `cp` needs the source to end in a path component, not in a directory that already exists —
   * copying *into* an existing directory would nest it (`dist/studio/studio`). Recreating the
   * destination first is what makes this a rename rather than a merge.
   */
  const installedStudio = join(prefix, "app", "dist", "studio");
  await rm(installedStudio, { recursive: true, force: true });
  await cp(studio, installedStudio, { recursive: true });
  const copiedIndex = join(installedStudio, "index.html");
  if (!existsSync(copiedIndex)) {
    throw new Error(`The Studio build did not copy: ${copiedIndex} is missing`);
  }

  /*
   * A minimal `package.json`.
   *
   * Electron needs `main` to find the entry point, and `type: module` because the bundle is ESM.
   * Nothing else is copied: the main-process bundle inlines every workspace dependency, so an
   * installed tree has no `node_modules` at all.
   */
  const pkg = {
    name: "mystudio",
    productName: "MyStudio",
    version: "0.1.0",
    private: true,
    type: "module",
    main: "./dist/main.js",
  };
  await writeFile(join(prefix, "app", "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  /*
   * The launcher.
   *
   * `readlink -f` resolves the script through symlinks, so installing it as a symlink on `$PATH`
   * still finds the real tree. `--ozone-platform` is deliberately **not** passed: the app decides
   * that from the environment (see `src/platform.ts`), and a launcher that overrides it would
   * quietly reintroduce the XWayland input-method defect.
   *
   * `"$@"` is forwarded verbatim so a project directory reaches `projectFromArgv` unchanged.
   */
  const launcher = `#!/bin/sh
# MyStudio launcher. Generated by scripts/install.mjs — edits here are overwritten.
set -eu

self=$(readlink -f "$0")
root=$(dirname "$self")

exec "$root/electron/electron" \\
  --no-sandbox \\
  "$root/app" \\
  "$@"
`;
  const launcherPath = join(prefix, "mystudio");
  await writeFile(launcherPath, launcher, "utf8");
  await chmod(launcherPath, 0o755);

  // A desktop entry, so the app is launchable without knowing the path.
  const entry = `[Desktop Entry]
Type=Application
Name=MyStudio
Comment=Annotate HyperFrames frames and send them to OpenCode
Exec=${launcherPath} %f
Terminal=false
Categories=AudioVideo;Video;Development;
MimeType=inode/directory;
`;
  await mkdir(join(prefix, "share", "applications"), { recursive: true });
  await writeFile(join(prefix, "share", "applications", "mystudio.desktop"), entry, "utf8");

  const installed = await stat(launcherPath);
  const executable = (installed.mode & 0o111) !== 0;
  if (!executable) throw new Error("The launcher was written but is not executable");

  console.log(`[install] launcher ${launcherPath}`);
  console.log("[install] done");
}

main().catch((error) => {
  console.error(`\n[install] FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
