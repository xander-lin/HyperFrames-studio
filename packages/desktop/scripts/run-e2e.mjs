/**
 * Bundle e2e/run.ts into a one-off script and run it.
 *
 * Why not `node --experimental-strip-types` directly: the e2e script imports
 * `@mystudio/protocol` and desktop's source, both TS with subpath exports, so running
 * it directly hits the resolver difference (same as found.md F-012). Flattening with
 * esbuild is the simplest route and uses the same toolchain as the production build.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workDir = await mkdtemp(join(tmpdir(), "mystudio-e2e-"));
const outfile = join(workDir, "run.mjs");

try {
  await build({
    entryPoints: [join(root, "e2e", "run.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    logLevel: "warning",
  });

  // After bundling, `import.meta.url` points at a temp directory, so default paths
  // derived from it in the script would all be wrong (found.md F-017). Compute the
  // real paths before bundling and pass them in through the environment.
  const child = spawn(process.execPath, [outfile], {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_STUDIO: process.env.E2E_STUDIO ?? join(root, "dist", "studio"),
      E2E_PACKAGE_ROOT: root,
    },
  });
  const code = await new Promise((resolveExit) => {
    child.on("exit", (exitCode, signal) => resolveExit(signal ? 1 : (exitCode ?? 1)));
  });
  process.exitCode = code;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
