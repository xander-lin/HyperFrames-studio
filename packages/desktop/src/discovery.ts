/**
 * Finding Hyperframes projects under a directory.
 *
 * ## The two shapes a picked directory can have
 *
 * The user clicks "Open folder" and points at something. It is one of:
 *
 * 1. **A project itself** — it has `index.html` plus a marker file. Open it.
 * 2. **A folder of projects** — the user keeps every deck side by side under one
 *    directory (`~/Documents/slides/deck-a`, `deck-b`, …). Making them pick again for
 *    each one would be friction with no purpose.
 *
 * The rule is therefore: if the directory is a project, use it; otherwise list the
 * subdirectories that are projects. Both are one function so the desktop app, the
 * dialog and the tests cannot disagree about what counts.
 *
 * ## Why the marker list mirrors upstream
 *
 * Hyperframes' own rule is `index.html` plus `hyperframes.json` or `package.json`.
 * Re-implementing it slightly differently produces the worst kind of divergence:
 * "Studio opens this project but the desktop app says it is not one". The same constant
 * is used by `project.ts` for a single directory; this module only adds the scan.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_MARKER_FILES, readProjectDisplayName } from "./project.js";

export interface DiscoveredProject {
  /** Absolute path. */
  readonly dir: string;
  /** Display name: the `name` field when available, otherwise the directory name. */
  readonly name: string;
  /** Where it was found: the directory itself, or one level below. */
  readonly depth: number;
}

export type DiscoveryResult =
  | { readonly kind: "project"; readonly project: DiscoveredProject }
  | { readonly kind: "collection"; readonly root: string; readonly projects: readonly DiscoveredProject[] }
  | { readonly kind: "empty"; readonly root: string; readonly scanned: number }
  | { readonly kind: "not-a-directory"; readonly root: string };

/** Whether a directory holds a Hyperframes project. */
async function isProjectDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  if (!entries) return false;
  const names = new Set(entries);
  if (!names.has("index.html")) return false;
  return PROJECT_MARKER_FILES.some((marker) => names.has(marker));
}

/**
 * Inspect a directory the user picked.
 *
 * Order matters: "is this a project" is checked **before** "does it contain projects",
 * because a project may well contain subdirectories (assets, compositions) that would
 * otherwise be offered as siblings of itself.
 */
export async function discoverProjects(root: string): Promise<DiscoveryResult> {
  const absolute = resolve(root);

  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) return { kind: "not-a-directory", root: absolute };

  if (await isProjectDir(absolute)) {
    return {
      kind: "project",
      project: { dir: absolute, name: await readProjectDisplayName(absolute), depth: 0 },
    };
  }

  /*
   * One level, on purpose. A project contains subdirectories (assets, compositions) that
   * are not projects; searching deeper would offer a project's own folders as siblings of
   * itself.
   */
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

  const found: DiscoveredProject[] = [];
  for (const entry of candidates) {
    const dir = join(absolute, entry.name);
    if (await isProjectDir(dir)) {
      found.push({ dir, name: await readProjectDisplayName(dir), depth: 1 });
    }
  }

  // Stable order: the user picks from a list, and a list that reshuffles is unusable.
  found.sort((a, b) => a.name.localeCompare(b.name));

  if (found.length === 0) return { kind: "empty", root: absolute, scanned: candidates.length };
  return { kind: "collection", root: absolute, projects: found };
}

