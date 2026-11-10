import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnnotationBundle } from "../annotation.js";
import type {
  DeliverOptions,
  DeliveryOutcome,
  InboxPayload,
  PromptSink,
} from "../sink.js";
import { validateBundle } from "../sink.js";
import { blockCount } from "../prompt.js";

/**
 * File outbox: write the annotation to disk so the plugin can consume it on its
 * next start.
 *
 * Its reason to exist is "never lose anything while the plugin is down". A user
 * may well draw a batch of annotations before noticing OpenCode is not running;
 * failing silently is the worst possible outcome. The plugin drains the outbox at
 * startup.
 */
export interface FileOutboxSinkOptions {
  /** Outbox directory. Prefer `<project>/.mystudio/outbox` so it travels with the project. */
  readonly dir: string;
}

export class FileOutboxSink implements PromptSink {
  readonly name = "file-outbox";

  constructor(private readonly options: FileOutboxSinkOptions) {}

  async deliver(
    bundle: AnnotationBundle,
    prompt: string,
    options: DeliverOptions = {},
  ): Promise<DeliveryOutcome> {
    const invalid = validateBundle(bundle);
    if (invalid) return { ok: false, code: "rejected", message: invalid };

    /*
     * The pin travels **with the record**. An annotation queued while OpenCode was down
     * must land where the user pointed it, not wherever auto-selection is when the
     * plugin finally starts.
     */
    const targetSessionID = options.targetSessionID?.trim();
    const appId = options.appId?.trim();
    const payload: InboxPayload = {
      schemaVersion: 1,
      prompt,
      bundle,
      ...(targetSessionID ? { targetSessionID } : {}),
      ...(appId ? { appId } : {}),
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    /*
     * The name counts **every block**, not just annotations.
     *
     * It used to say `${annotations.length}items`, so a request holding `Element 1` and
     * `Capture 2` was written as `…_0items.json` — a file that claims to be empty while
     * carrying two blocks. That name is exactly what someone reads while debugging a missing
     * delivery (found.md F-129).
     */
    const base = `${stamp}_${blockCount(bundle)}items`;
    const target = join(this.options.dir, `${base}.json`);

    try {
      await mkdir(this.options.dir, { recursive: true });
      // Write a temporary file then rename: the consumer may be scanning the
      // directory and must never read a half-written JSON file.
      const temp = `${target}.tmp`;
      await writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
      await rename(temp, target);
      return { ok: true, deliveredAt: Date.now(), detail: target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "write-failed", message: `Failed to write the outbox: ${message}` };
    }
  }
}

/** Read every pending payload in the outbox, in filename (= time) order. */
export async function readOutbox(dir: string): Promise<InboxPayload[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const payloads: InboxPayload[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isInboxPayload(parsed)) payloads.push(parsed);
    } catch {
      // Skip broken files: one corrupt record must not block the whole outbox.
    }
  }
  return payloads;
}

function isInboxPayload(value: unknown): value is InboxPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) return false;
  if (!("prompt" in value) || typeof value.prompt !== "string") return false;
  return "bundle" in value && typeof value.bundle === "object" && value.bundle !== null;
}
