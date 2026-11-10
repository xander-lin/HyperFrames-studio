/**
 * Copy studio-shell's build output into the desktop distribution directory.
 *
 * Copy rather than inline at bundle time because Studio is a web app and the main
 * process only serves static files. Keeping them separate lets the frontend build and
 * the main-process code update independently, and makes opening DevTools to debug
 * straightforward.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "studio-shell", "dist");
const target = join(here, "..", "dist", "studio");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`[mystudio] Studio build copied to ${target}`);
