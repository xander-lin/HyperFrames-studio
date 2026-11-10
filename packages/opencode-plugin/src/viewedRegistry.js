/**
 * "Which session did the user look at last" — the live signal.
 *
 * ## Why timestamps in the session list are second-best
 *
 * `Session.Info.time.viewed` says when a session was last looked at, and comparing those
 * is how the first version picked a target. It works, but it is a **snapshot guess**: the
 * list has to be fetched, paged and sorted, and the answer is only as fresh as the fetch.
 *
 * OpenCode emits `session.viewed` for each look. Subscribing turns the guess into a fact:
 * the plugin knows the last session the user opened, at the moment they opened it.
 *
 * ## Why it is a registry rather than plugin-level state
 *
 * Delivery happens in the inbox handler and in the outbox replay loop — two places that
 * must read the same value. A small object, created once in `setup` and passed to both,
 * keeps the value in one place and makes it fakeable in tests.
 *
 * @typedef {{ sessionID: string, at: number }} ViewedRecord
 */

/**
 * Read the session id out of a `session.viewed` event.
 *
 * @param {any} event
 * @returns {string | null}
 */
export function viewedSessionID(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type !== "session.viewed") return null;
  const id = event?.data?.sessionID ?? event?.sessionID;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Create the last-viewed registry.
 *
 * `note` is separate from the subscription so the rule can be tested by feeding events
 * directly, with no OpenCode server involved.
 */
export function createViewedRegistry() {
  /** @type {ViewedRecord | null} */
  let last = null;

  return {
    /** @param {any} event */
    note(event) {
      const id = viewedSessionID(event);
      if (!id) return false;
      last = { sessionID: id, at: Date.now() };
      return true;
    },
    /** @returns {ViewedRecord | null} */
    last() {
      return last;
    },
    /** Forget the current session, e.g. when it is deleted. */
    clear() {
      last = null;
    },
  };
}

/**
 * Follow `session.viewed` events for the lifetime of the plugin.
 *
 * Never fatal: a missing `event` domain (older host, test context) simply means the
 * timestamp fallback in `sessionTarget.js` is used. The loop is detached on purpose —
 * `setup` must not block waiting for events.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof createViewedRegistry>} registry
 * @param {(msg: string, detail?: unknown) => void} [log]
 * @returns {() => void} stop function
 */
export function trackViewedSessions(ctx, registry, log = () => {}) {
  const subscribe = ctx?.event?.subscribe;
  if (typeof subscribe !== "function") return () => {};

  let stopped = false;

  void (async () => {
    try {
      for await (const event of subscribe({ types: ["session.viewed"] })) {
        if (stopped) return;
        const id = viewedSessionID(event);
        if (!id) continue;
        registry.note(event);
        log("Last-viewed session changed", { sessionID: id });
      }
    } catch (error) {
      // A broken subscription must not take the plugin down; delivery still works from
      // the session list.
      log("session.viewed subscription ended", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return () => {
    stopped = true;
  };
}
