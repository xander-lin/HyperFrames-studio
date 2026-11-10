/**
 * The shared runtime directory: where apps and subscriptions meet.
 *
 * Node-only (uses `os` / `fs`), hence the `./node` subpath. The record **shapes** are in
 * `../presence.ts`, which stays DOM-free, so a browser-side reader can use the types
 * without pulling in filesystem code.
 *
 * ## Layout
 *
 * ```
 * <root>/mystudio/
 *   apps/<appId>.json
 *   subscriptions/<appId>/<sessionID>.json
 * ```
 *
 * `<root>` is `$XDG_RUNTIME_DIR` when available (it is per-user, cleared on logout, and
 * already the convention for "live IPC endpoint" on Linux), else `os.tmpdir()`. It is
 * **injectable** so tests never touch the real one.
 *
 * ## Why plain files instead of a socket or a port registry
 *
 * Neither side may assume the other is running, and both must survive the other's restart.
 * A directory of small JSON files has no lifecycle: whoever writes last wins, stale entries
 * are recognised by heartbeat, and nothing has to be re-established after a crash.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isPresenceFresh,
  type AppPresence,
  type Subscription,
} from "../presence.js";

/** Root of the shared state. Per-user, and wiped at logout on Linux. */
export function runtimeRoot(): string {
  const xdg = process.env["XDG_RUNTIME_DIR"];
  const base = typeof xdg === "string" && xdg.trim() !== "" ? xdg : tmpdir();
  return join(base, "mystudio");
}

export function appsDir(root = runtimeRoot()): string {
  return join(root, "apps");
}

export function subscriptionsDir(root = runtimeRoot()): string {
  return join(root, "subscriptions");
}

function appPath(appId: string, root: string): string {
  return join(appsDir(root), `${safe(appId)}.json`);
}

function subscriptionPath(appId: string, sessionID: string, root: string): string {
  return join(subscriptionsDir(root), safe(appId), `${safe(sessionID)}.json`);
}

/**
 * A filesystem-safe form of an id.
 *
 * Ids come from other processes, so they are untrusted input: without this, an id of `..`
 * or `a/b` would address a file outside the registry.
 */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Write a JSON record atomically: a crash must not leave a half-parsed file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    // Missing or corrupt: the caller decides what that means. No record is ever worth
    // failing a delivery over.
    return null;
  }
}

// ── Presence ─────────────────────────────────────────────────────────────

export async function publishPresence(
  presence: AppPresence,
  root = runtimeRoot(),
): Promise<void> {
  await writeJson(appPath(presence.appId, root), presence);
}

export async function withdrawPresence(appId: string, root = runtimeRoot()): Promise<void> {
  await rm(appPath(appId, root), { force: true }).catch(() => undefined);
}

/** Every **live** app. Stale records are ignored (and cleaned up opportunistically). */
export async function listApps(
  root = runtimeRoot(),
  now = Date.now(),
): Promise<AppPresence[]> {
  let names: string[];
  try {
    names = await readdir(appsDir(root));
  } catch {
    return [];
  }

  const apps: AppPresence[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readJson(join(appsDir(root), name));
    if (!isPresence(raw)) continue;
    if (!isPresenceFresh(raw, now)) {
      // The app died without cleaning up (kill -9). Remove it: a stale entry would keep
      // being offered to the agent as a place to subscribe.
      await rm(join(appsDir(root), name), { force: true }).catch(() => undefined);
      continue;
    }
    apps.push(raw);
  }
  return apps.sort((a, b) => a.startedAt - b.startedAt);
}

// ── Subscriptions ────────────────────────────────────────────────────────

export async function addSubscription(
  subscription: Subscription,
  root = runtimeRoot(),
): Promise<void> {
  await writeJson(
    subscriptionPath(subscription.appId, subscription.sessionID, root),
    subscription,
  );
}

export async function removeSubscription(
  appId: string,
  sessionID: string,
  root = runtimeRoot(),
): Promise<void> {
  await rm(subscriptionPath(appId, sessionID, root), { force: true }).catch(() => undefined);
}

/**
 * Subscriptions for one app.
 *
 * Records whose app is not live are dropped on the way out: without that, a killed app
 * leaves an entry the UI would keep listing as a recipient.
 */
export async function listSubscriptions(
  appId: string,
  root = runtimeRoot(),
): Promise<Subscription[]> {
  let names: string[];
  try {
    names = await readdir(join(subscriptionsDir(root), safe(appId)));
  } catch {
    return [];
  }

  const subscriptions: Subscription[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readJson(join(subscriptionsDir(root), safe(appId), name));
    if (isSubscription(raw) && raw.appId === appId) subscriptions.push(raw);
  }
  return subscriptions.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Subscriptions that apply to an app: its own, **plus those of earlier launches of the same
 * project**.
 *
 * A subscription says "this conversation wants this project's annotations". Keying it only
 * by the launch id made it die with the window: restart MyStudio and nobody is subscribed,
 * so the next delivery queued instead of arriving — which is what the user hit (found.md
 * F-098).
 *
 * The launch id still matters, and still wins:
 * - two windows on one project are two apps, and a subscription made in either is listed for
 *   both — deliberate, because it names a **project**, not a window;
 * - an explicit `appId` in the subscription is preferred when resolving an order, so a
 *   subscription made for a specific window is not silently applied to the other one unless
 *   nothing better exists.
 *
 * Records of a *different* project are never included: that would deliver one deck's
 * annotations into another deck's conversation.
 */
export async function subscriptionsForApp(
  app: { readonly appId: string; readonly projectDir: string },
  root = runtimeRoot(),
): Promise<Subscription[]> {
  const own = await listSubscriptions(app.appId, root);
  const wanted = normalizeProject(app.projectDir);
  if (!wanted) return own;

  let appIds: string[];
  try {
    appIds = await readdir(subscriptionsDir(root));
  } catch {
    return own;
  }

  const seen = new Set(own.map((entry) => entry.sessionID));
  const inherited: Subscription[] = [];
  for (const appId of appIds) {
    if (appId === app.appId) continue;
    for (const entry of await listSubscriptions(appId, root)) {
      if (seen.has(entry.sessionID)) continue;
      if (normalizeProject(entry.projectDir) !== wanted) continue;
      seen.add(entry.sessionID);
      inherited.push(entry);
    }
  }

  return [...own, ...inherited].sort((a, b) => a.createdAt - b.createdAt);
}

/** Trailing separators must not make `/p/deck` and `/p/deck/` two different projects. */
function normalizeProject(dir: string): string {
  return (dir ?? "").replace(/[\\/]+$/, "");
}

/** Every app this session is subscribed to. */
export async function subscriptionsOfSession(
  sessionID: string,
  root = runtimeRoot(),
): Promise<Subscription[]> {
  let appIds: string[];
  try {
    appIds = await readdir(subscriptionsDir(root));
  } catch {
    return [];
  }

  const found: Subscription[] = [];
  for (const appId of appIds) {
    for (const subscription of await listSubscriptions(appId, root)) {
      if (subscription.sessionID === sessionID) found.push(subscription);
    }
  }
  return found;
}

/**
 * Drop subscriptions that no longer belong to a live app.
 *
 * Called by a plugin when it starts and when it lists apps, so a crashed MyStudio instance
 * does not leave conversations permanently "subscribed" to nothing.
 */
export async function pruneDeadSubscriptions(
  root = runtimeRoot(),
  now = Date.now(),
): Promise<number> {
  const live = new Set((await listApps(root, now)).map((app) => app.appId));
  let removed = 0;

  let appIds: string[];
  try {
    appIds = await readdir(subscriptionsDir(root));
  } catch {
    return 0;
  }

  for (const appId of appIds) {
    if (live.has(appId)) continue;
    const dir = join(subscriptionsDir(root), appId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
      removed += 1;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}

// ── Validation ───────────────────────────────────────────────────────────

function isPresence(value: unknown): value is AppPresence {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === 1 &&
    typeof record["appId"] === "string" &&
    typeof record["projectDir"] === "string" &&
    typeof record["projectName"] === "string" &&
    typeof record["endpoint"] === "string" &&
    typeof record["startedAt"] === "number" &&
    typeof record["heartbeatAt"] === "number"
  );
}

function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === 1 &&
    typeof record["appId"] === "string" &&
    typeof record["projectDir"] === "string" &&
    typeof record["sessionID"] === "string" &&
    typeof record["pluginEndpoint"] === "string"
  );
}
