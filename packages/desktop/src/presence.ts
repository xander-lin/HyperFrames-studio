/**
 * This app's presence record: "I am here, this is my project, this is my endpoint".
 *
 * The plugin cannot enumerate MyStudio instances any other way — they are independent
 * processes on the same machine, and a fixed port would collide the moment a second window
 * opens. So each instance writes a small record into the shared runtime directory and
 * refreshes its heartbeat; readers treat an old heartbeat as "gone".
 *
 * The heartbeat matters more than it looks: without it, a crashed app stays in the list
 * forever and the agent keeps offering to subscribe to something that cannot deliver.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  PRESENCE_HEARTBEAT_MS,
  publishPresence,
  withdrawPresence,
  type AppPresence,
} from "@mystudio/protocol/node";

export interface PresenceOptions {
  /**
   * Identity of this launch.
   *
   * Passed in rather than generated here: the app server keys subscriptions by it, so a
   * second id would advertise one identity and look up another — the registry would then
   * report "no subscribers" while subscriptions exist (found.md F-085).
   */
  readonly appId: string;
  readonly projectDir: string;
  readonly projectName: string;
  /** The app server's base URL; this is what the plugin posts back to. */
  readonly endpoint: string;
  /** Registry root (injectable for tests). */
  readonly root?: string;
  /** Override for tests; defaults to `PRESENCE_HEARTBEAT_MS`. */
  readonly heartbeatMs?: number;
}

export interface PresenceHandle {
  readonly appId: string;
  /** Force a heartbeat now (e.g. right after the port is known). */
  beat: () => Promise<void>;
  /** Stop heartbeating and remove the record. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * A fresh id per launch.
 *
 * Deliberately not derived from the project path: two windows may handle the **same**
 * project, and the user has to be able to tell them apart when subscribing. The hostname
 * is included so records from another machine's tmpdir (shared `/tmp` in a container, say)
 * are recognisable in a log.
 */
export function newAppId(now = Date.now()): string {
  const suffix = randomBytes(3).toString("hex");
  return `app_${now.toString(36)}_${suffix}`;
}

/** Start publishing presence. Returns a handle that stops it. */
export async function publishAppPresence(options: PresenceOptions): Promise<PresenceHandle> {
  const { appId } = options;
  const startedAt = Date.now();
  let stopped = false;

  const record = (): AppPresence => ({
    version: 1,
    appId,
    projectDir: options.projectDir,
    projectName: options.projectName,
    endpoint: options.endpoint,
    pid: process.pid,
    startedAt,
    heartbeatAt: Date.now(),
  });

  const beat = async (): Promise<void> => {
    if (stopped) return;
    await publishPresence(record(), options.root).catch(() => undefined);
  };

  await beat();

  const intervalMs = options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  // Never keep the process alive just to advertise itself.
  if (typeof timer.unref === "function") timer.unref();

  return {
    appId,
    beat,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await withdrawPresence(appId, options.root).catch(() => undefined);
    },
  };
}

/** Label for a presence record in the agent's app list, e.g. `deck-avl (on build-box)`. */
export function describePresence(presence: AppPresence): string {
  return `${presence.projectName} (on ${hostname()})`;
}
