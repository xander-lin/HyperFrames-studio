/**
 * Presence and subscriptions: how a conversation says "send me this app's annotations".
 *
 * ## Why this replaces guessing
 *
 * OpenCode runs many windows in one server, so a plugin cannot see which window is
 * focused. Every earlier design therefore **guessed** — by `time.viewed`, or by "the
 * session you looked at last". A guess is wrong exactly when it matters: two windows open,
 * one annotation delivered to the other one.
 *
 * The fix is not a better guess, it is a **declaration**. The agent, inside the
 * conversation that wants the annotations, runs a tool and subscribes. From then on this
 * app delivers to the subscribers it has, and to nobody else. Several conversations may
 * subscribe to the same app; all of them receive each delivery.
 *
 * ## Why the two sides meet through a directory, not through each other
 *
 * - The plugin cannot know which MyStudio instances are running, and must not depend on a
 *   fixed port (two instances, or two OpenCode servers, both have to work).
 * - The app cannot know which OpenCode servers exist, let alone their ports.
 *
 * So each side publishes what it knows into one shared runtime directory:
 *
 * ```
 * <runtime>/mystudio/
 *   apps/<appId>.json                    presence: this app, its project, its endpoint
 *   subscriptions/<appId>/<sessionID>.json   "this conversation wants that app"
 * ```
 *
 * The directory is the **only** shared state, and every record is a small JSON file written
 * atomically. That keeps both processes independent: either may restart at any moment.
 */

/** A running MyStudio instance, as it advertises itself. */
export interface AppPresence {
  readonly version: 1;
  /**
   * Identity of **this launch**, not of the project.
   *
   * Two windows may handle the same project ("we may have started several apps"), and the
   * user has to be able to pick one. A per-launch id makes them distinct; a project path
   * would make them indistinguishable.
   */
  readonly appId: string;
  readonly projectDir: string;
  readonly projectName: string;
  /** Loopback base URL of this app's server, e.g. `http://127.0.0.1:4317`. */
  readonly endpoint: string;
  readonly pid: number;
  readonly startedAt: number;
  /** Rewritten every few seconds; a stale heartbeat means the app is gone. */
  readonly heartbeatAt: number;
}

/** One conversation's subscription to one app. */
export interface Subscription {
  readonly version: 1;
  readonly appId: string;
  /** Copied from presence so a reader can prune without a second lookup. */
  readonly projectDir: string;
  /** OpenCode session that wants this app's annotations. */
  readonly sessionID: string;
  /** For the app's UI, so it can name the conversations it will deliver to. */
  readonly sessionTitle?: string;
  /**
   * Where to POST the delivery, i.e. the inbox of the OpenCode server that owns this
   * session. A subscription is only useful if the app can reach the plugin that wrote it.
   */
  readonly pluginEndpoint: string;
  readonly createdAt: number;
}

/** How long a presence record stays believable without a heartbeat. */
export const PRESENCE_TTL_MS = 60_000;

/** How often a live app must heartbeat to stay inside that window. */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/** Whether a presence record is still believable at `now`. */
export function isPresenceFresh(presence: AppPresence, now: number): boolean {
  if (!Number.isFinite(presence.heartbeatAt)) return false;
  const age = now - presence.heartbeatAt;
  // A clock skew that puts the heartbeat in the future is treated as fresh-but-suspect:
  // refusing it would break on a machine whose clock jumped, and the record is harmless.
  return age < PRESENCE_TTL_MS;
}

/**
 * Whether a subscription still makes sense.
 *
 * A subscription dies with its app: the app instance it names is gone, so nothing can ever
 * deliver through it again. Keeping the record would show a phantom subscriber in the UI.
 */
export function isSubscriptionLive(
  subscription: Subscription,
  shows: readonly AppPresence[],
): boolean {
  return shows.some((presence) => presence.appId === subscription.appId);
}
