/**
 * Bundle the Electron main process.
 *
 * Why bundling is required instead of shipping the tsc output: Electron's ESM
 * resolver does not follow pnpm's workspace symlinks for bare specifiers
 * (`@mystudio/protocol/node`), and the symptom is an **import that hangs silently** —
 * the process runs, no port opens, the log stays empty, and it is very hard to
 * locate. See found.md F-012.
 *
 * esbuild inlines workspace dependencies into one file, sidestepping the resolver
 * difference; `electron` itself must stay external (the runtime provides it).
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

await rm(join(root, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Electron is provided by the host and must not be inlined.
  external: ["electron"],
  // Keep node: builtins intact in the ESM output.
  packages: "bundle",
  logLevel: "info",
});

console.log("[mystudio] Main process bundled to dist/main.js");
