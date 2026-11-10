/**
 * Project detection.
 *
 * Hyperframes' rule is narrow: the directory has `index.html` and a marker file such
 * as `hyperframes.json` or `package.json` (see upstream core/projectRule.ts).
 *
 * The rule is replicated rather than calling the upstream package: the desktop app
 * does not need all of core in the main process, and the logic is tiny and nearly
 * never changes. **But it must match upstream** — a mismatch produces the hardest
 * divergence of all: "Studio opens it but the desktop app says it is not a project".
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/** Equivalent of upstream's PROJECT_MARKER_FILES, shared with `discovery.ts`. */
export const PROJECT_MARKER_FILES = ["hyperframes.json", "package.json"] as const;

export interface DetectedProject {
  /** Absolute path. */
  readonly dir: string;
  /** Display name, defaulting to the directory name. */
  readonly name: string;
  /** Whether the main composition (`index.html`) exists. */
  readonly hasEntry: boolean;
}

export type DetectResult =
  | { readonly ok: true; readonly project: DetectedProject }
  | { readonly ok: false; readonly reason: "not-a-directory" | "missing-entry" | "missing-marker" };

/** Whether a directory is a Hyperframes project. */
export async function detectProject(dir: string): Promise<DetectResult> {
  const absolute = resolve(dir);

  const info = await statSafe(absolute);
  if (!info?.isDirectory()) return { ok: false, reason: "not-a-directory" };

  const entries = await readdir(absolute).catch(() => [] as string[]);
  const names = new Set(entries);
  const hasEntry = names.has("index.html");
  if (!hasEntry) return { ok: false, reason: "missing-entry" };

  const hasMarker = PROJECT_MARKER_FILES.some((marker) => names.has(marker));
  if (!hasMarker) return { ok: false, reason: "missing-marker" };

  return {
    ok: true,
    project: {
      dir: absolute,
      name: await readProjectDisplayName(absolute),
      hasEntry,
    },
  };
}

/**
 * Display name: `name` from `hyperframes.json` when present, otherwise the directory
 * name.
 *
 * A read failure falls back to the directory name — a display name must never be the
 * reason a project fails to open. Exported because `discovery.ts` lists projects and must
 * use exactly the same rule; two readers of the same manifest would eventually disagree.
 */
export async function readProjectDisplayName(dir: string): Promise<string> {
  try {
    const raw = await readFile(join(dir, "hyperframes.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
      const name = parsed.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  } catch {
    // No marker, invalid JSON, or no name — all fall back to the directory name.
  }
  return basename(dir);
}

/** Turn a failure reason into a sentence a user can act on. */
export function explainDetectFailure(reason: string): string {
  switch (reason) {
    case "not-a-directory":
      return "That path is not a directory.";
    case "missing-entry":
      return "No index.html here — a Hyperframes project must have index.html as its main composition.";
    case "missing-marker":
      return "No hyperframes.json or package.json found; this does not look like a Hyperframes project.";
    default:
      return "Could not recognise this directory.";
  }
}

async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export { join };
