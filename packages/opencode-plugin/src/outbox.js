/**
 * Consumer side of the file outbox.
 *
 * Why it exists: while no conversation is subscribed (or while the plugin is not running),
 * the desktop app queues annotations to `<project>/.mystudio/outbox/`. This file is where
 * that promise is kept — without it, annotations written to disk would never reach anyone.
 *
 * ## Who gets a queued record
 *
 * The same rule as live delivery: **the conversations subscribed to the app that produced
 * it**. A record is only deliverable by the plugin instance that owns one of those
 * subscriptions, because `session.prompt` can only be called for sessions in this server.
 * So:
 *
 * 1. a record naming an `appId` is delivered to the subscriptions of that app;
 * 2. an older record without one is matched by project directory;
 * 3. if none of the subscriptions here belong to this plugin, the file is **left alone**:
 *    another OpenCode instance may own them, and it will drain on its next round.
 *
 * Design points:
 * 1. **Claim before injecting.** Atomically rename the file to `.claimed`, move it into
 *    `sent/` only after a successful injection, and rename it back on failure. Nothing is
 *    delivered twice (rename is atomic) and nothing is lost to a crash.
 * 2. **One failure does not block the rest.** A single bad JSON file must not stall the
 *    whole queue.
 * 3. **Poll instead of watch.** The outbox directory may be created after the plugin
 *    starts, and `fs.watch` cannot watch a path that does not exist; a `readdir` is cheap
 *    enough.
 */

import { readdir, readFile, rename, mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { injectPayload } from "./injector.js";
import { validatePayload } from "./payload.js";
import { listApps, listSubscriptions, subscriptionsForApp } from "@mystudio/protocol/node";

/** Temporary suffix marking a record as claimed by some process. */
const CLAIM_SUFFIX = ".claimed";

/** Where delivered records are archived (kept as an audit trail). */
const SENT_DIR = "sent";

/** Where undeliverable records are parked so they are not retried forever. */
const REJECTED_DIR = "rejected";

/**
 * Which sessions this plugin should deliver a queued record to.
 *
 * `ownEndpoint` is what makes this honest: a session subscribed through a *different*
 * OpenCode server cannot be prompted from here, and pretending otherwise would either fail
 * or — worse — deliver into a session of the same id on the wrong server.
 *
 * @param {any} payload
 * @param {{root?: string, ownEndpoint: string}} options
 * @returns {Promise<Array<{sessionID: string, title?: string}>>}
 */
async function targetsFor(payload, options) {
  const bundle = payload?.bundle ?? {};
  const projectDir = typeof bundle.projectDir === "string" ? bundle.projectDir : "";
  const normalize = (dir) => String(dir ?? "").replace(/[\\/]+$/, "");
  const apps = await listApps(options.root);

  /*
   * Which subscriptions could receive this record.
   *
   * Normally: the ones belonging to the app that wrote it, or to any live app of the same
   * project. But a queued record may name an app that has since **gone away** — MyStudio was
   * restarted, or closed, before the plugin drained it. That app has no presence entry any
   * more, so "live apps" finds nothing and the delivery would sit in the outbox forever even
   * though the conversation that asked for it is still there.
   *
   * So the record's own `appId` and `projectDir` are also consulted directly. This is what
   * makes "queued while the app was down" actually deliverable later (found.md F-098).
   */
  const candidates = [];
  for (const app of apps) {
    const matchesById = typeof payload?.appId === "string" && payload.appId
      ? app.appId === payload.appId
      : normalize(app.projectDir) === normalize(projectDir);
    if (matchesById) candidates.push(...(await subscriptionsForApp(app, options.root)));
  }

  const recordedAppId =
    typeof payload?.appId === "string" && payload.appId ? payload.appId : "";
  if (recordedAppId) {
    candidates.push(...(await listSubscriptions(recordedAppId, options.root)));
  }

  const own = options.ownEndpoint.replace(/\/+$/, "");
  const targets = [];
  const seen = new Set();
  for (const subscription of candidates) {
    if (subscription.pluginEndpoint.replace(/\/+$/, "") !== own) continue;
    if (normalize(subscription.projectDir) !== normalize(projectDir)) continue;
    if (seen.has(subscription.sessionID)) continue;
    seen.add(subscription.sessionID);
    targets.push({
      sessionID: subscription.sessionID,
      ...(subscription.sessionTitle ? { title: subscription.sessionTitle } : {}),
    });
  }

  /*
   * An explicit pin is still honoured: it came from a caller that knew where it wanted this
   * to land, and refusing it because no subscription exists would make recovery harder than
   * the thing it protects.
   */
  const pinned = typeof payload?.targetSessionID === "string" ? payload.targetSessionID.trim() : "";
  if (pinned && !targets.some((target) => target.sessionID === pinned)) {
    targets.push({ sessionID: pinned });
  }

  return targets;
}

/**
 * Read and inject one record from disk.
 *
 * @param {any} ctx
 * @param {string} dir
 * @param {string} name
 * @param {{mode?: "queue"|"run", root?: string, ownEndpoint: string, viewed?: {last: () => ({sessionID: string} | null)} | null}} options
 * @returns {Promise<{ok: true, delivered: number, sessionIDs: string[]} | {ok: false, deferred?: boolean, message: string}>}
 */
async function consumeFile(ctx, dir, name, options) {
  const original = join(dir, name);
  const claimed = `${original}${CLAIM_SUFFIX}`;

  // Claim: only the process that wins the rename owns this record. Under concurrency
  // exactly one wins; the loser gets ENOENT and skips silently.
  try {
    await rename(original, claimed);
  } catch {
    return { ok: false, message: "Already claimed by another process or gone" };
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(claimed, "utf8"));
  } catch (error) {
    // A corrupt file must not be retried every poll; park it in `rejected/`.
    await park(dir, claimed, name, REJECTED_DIR);
    return {
      ok: false,
      message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const invalid = validatePayload(payload);
  if (invalid) {
    await park(dir, claimed, name, REJECTED_DIR);
    return { ok: false, message: invalid };
  }

  const targets = await targetsFor(payload, options);
  if (targets.length === 0) {
    /*
     * Nobody this plugin can reach wants it — yet. Put the original name back and let the
     * next round (or another OpenCode instance) try; parking it in `rejected/` would
     * permanently discard an annotation that is merely early.
     */
    await rename(claimed, original).catch(() => undefined);
    return {
      ok: false,
      deferred: true,
      message: "No conversation subscribed here yet; left queued",
    };
  }

  const sessionIDs = [];
  for (const target of targets) {
    try {
      await injectPayload(
        ctx,
        { ...payload, targetSessionID: target.sessionID },
        {
          ...(options.mode ? { mode: options.mode } : {}),
          lastViewedSessionID: options.viewed?.last()?.sessionID ?? null,
        },
      );
      sessionIDs.push(target.sessionID);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionIDs.length === 0) {
        // Nothing landed: put it back so a later round can retry.
        await rename(claimed, original).catch(() => undefined);
        return { ok: false, message };
      }
      // Partial success: keep what was delivered, report the rest. Retrying the whole
      // record would duplicate the prompt for the sessions that already got it.
      return { ok: true, delivered: sessionIDs.length, sessionIDs };
    }
  }

  await park(dir, claimed, name, SENT_DIR);
  return { ok: true, delivered: sessionIDs.length, sessionIDs };
}

/**
 * Move a processed record into `dir/sent` or `dir/rejected`, keeping an audit trail
 * instead of deleting it.
 *
 * Failing to move must not affect the main flow: the content, and the fact that it was
 * delivered, must not be lost because archiving failed.
 *
 * @param {string} dir
 * @param {string} claimed
 * @param {string} name
 * @param {string} bucket
 */
async function park(dir, claimed, name, bucket) {
  const target = join(dir, bucket);
  try {
    await mkdir(target, { recursive: true });
    await rename(claimed, join(target, name));
    return;
  } catch {
    // Fall through to the non-destructive fallback below.
  }
  /*
   * Archiving failed. Never delete the record — that would silently destroy the only
   * copy of an annotation. Try a `.failed` suffix next to the original; if even that
   * rename fails, leave the `.claimed` file where it is. Both names are ignored by the
   * scan (which only picks `.json`), so nothing loops, and a human can still inspect
   * the file.
   */
  await rename(claimed, `${join(dir, name)}.failed`).catch(() => undefined);
}

/**
 * Consume every pending record in one outbox directory.
 *
 * @param {any} ctx
 * @param {string} dir
 * @param {{mode?: "queue"|"run", root?: string, ownEndpoint: string, log?: (msg: string, detail?: unknown) => void}} [options]
 * @returns {Promise<{delivered: number, failed: number, skipped: boolean}>}
 */
export async function drainOutbox(ctx, dir, options = {}) {
  const log = options.log ?? (() => undefined);
  const ownEndpoint = options.ownEndpoint ?? "";

  let names;
  try {
    names = await readdir(dir);
  } catch {
    // A missing directory is normal (no delivery has failed yet). Not an error.
    return { delivered: 0, failed: 0, skipped: true };
  }

  const pending = names.filter((name) => name.endsWith(".json")).sort();
  if (pending.length === 0) return { delivered: 0, failed: 0, skipped: false };

  let delivered = 0;
  let failed = 0;
  for (const name of pending) {
    const result = await consumeFile(ctx, dir, name, { ...options, ownEndpoint });
    if (result.ok) {
      delivered += 1;
      log("Replayed a queued annotation", { file: name, sessions: result.sessionIDs });
    } else if (result.deferred) {
      // Not a failure: the record stays for whoever is subscribed later.
      log("Queued annotation has no subscriber here", { file: name });
    } else {
      failed += 1;
      log("Queued annotation could not be processed", { file: name, error: result.message });
    }
  }
  return { delivered, failed, skipped: false };
}

/**
 * The set of outbox directories to scan.
 *
 * Defaults to `.mystudio/outbox` under OpenCode's working directory — in the vast
 * majority of cases the user starts opencode inside the project they are editing.
 * `MYSTUDIO_OUTBOX_DIRS` (path-separator separated) watches several projects at once.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function outboxDirsFor(cwd) {
  const configured = process.env.MYSTUDIO_OUTBOX_DIRS;
  if (typeof configured === "string" && configured.trim()) {
    return configured
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof cwd !== "string" || !cwd) return [];
  return [join(cwd, ".mystudio", "outbox")];
}

/**
 * Start background replay: scan once at startup, then periodically.
 *
 * The timer is `unref()`ed: it must not keep the opencode process alive on its own.
 *
 * @param {any} ctx
 * @param {string[]} dirs
 * @param {{intervalMs?: number, mode?: "queue"|"run", root?: string, ownEndpoint: string, viewed?: {last: () => ({sessionID: string} | null)} | null, log?: (msg: string, detail?: unknown) => void}} [options]
 * @returns {{stop: () => void, drainOnce: () => Promise<void>}}
 */
export function startOutboxDrain(ctx, dirs, options = {}) {
  const intervalMs = options.intervalMs ?? 5_000;
  const log = options.log ?? (() => undefined);
  let running = false;

  const drainOnce = async () => {
    // Skip a round if the previous one has not finished: delivery can be slow, and
    // stacking rounds only multiplies pressure.
    if (running) return;
    running = true;
    try {
      for (const dir of dirs) {
        const result = await drainOutbox(ctx, dir, { ...options, log });
        if (result.delivered > 0) {
          log("Outbox replay finished", { dir, delivered: result.delivered });
        }
      }
    } catch (error) {
      log("Outbox scan failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  void drainOnce();
  const timer = setInterval(() => void drainOnce(), intervalMs);
  // Do not keep the process alive.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => clearInterval(timer),
    drainOnce,
  };
}
