/**
 * The MyStudio OpenCode plugin (server side).
 *
 * It does three things, all on the receiving side:
 * 1. **offer the subscription tools** (`mystudio_apps`, `mystudio_subscribe`,
 *    `mystudio_unsubscribe`). A conversation declares that it wants a running app's
 *    annotations; the app never has to guess which window is meant;
 * 2. listen for annotation prompts sent by MyStudio (loopback HTTP inbox → inject into
 *    the sessions that subscribed);
 * 3. consume annotations the desktop app queued on disk while nothing was subscribed
 *    (`<project>/.mystudio/outbox/`).
 *
 * It has no chat UI, takes over no context and never touches a model — those are
 * OpenCode's job.
 *
 * ## Follow the official plugin contract
 *
 * `Plugin.define({ id, setup })` rather than a bare object. Early versions exported
 * `{ id, setup }` directly; it ran, but it bypassed the official entry point.
 * `define` is part of the contract and is how upstream guarantees compatibility
 * across upgrades.
 *
 * ## Installation
 *
 * The plugin path **must point at a directory**; a single `.js` file is skipped.
 * The config key lives in `opencode.json(c)`.
 *
 * ## Do not register during development
 *
 * Once this plugin is in the global config it runs in **every** OpenCode session;
 * any syntax error breaks every session the user has. Verify it with a separate
 * `OPENCODE_CONFIG` pointing at a temporary config before registering.
 */

import { Plugin } from "@opencode/plugin";
import { DEFAULT_PORT, startInbox } from "./src/inboxServer.js";
import { outboxDirsFor, startOutboxDrain } from "./src/outbox.js";
import { parsePort } from "./src/port.js";
import { createViewedRegistry, trackViewedSessions } from "./src/viewedRegistry.js";
import { registerTools } from "./src/tools.js";
import { pruneDeadSubscriptions } from "@mystudio/protocol/node";

/** Environment override so several projects can run side by side. */
const PORT = parsePort(
  process.env.MYSTUDIO_INBOX_PORT && process.env.MYSTUDIO_INBOX_PORT.trim()
    ? process.env.MYSTUDIO_INBOX_PORT
    : String(DEFAULT_PORT),
);

/**
 * Single log prefix, so entries are easy to filter in `opencode run --print-logs`.
 *
 * Note: these messages are stderr only, never injected into a session.
 *
 * @param {string} message
 * @param {unknown} [detail]
 */
function log(message, detail) {
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.error(`[mystudio] ${message}${suffix}`);
}

/**
 * Directory of this plugin instance.
 *
 * Careful: this is the **plugin instance's** location, not the location of every
 * session it can access. It is therefore only used to decide which outbox directory
 * to scan, never to decide which session the user is looking at — that is
 * `session.time.viewed`.
 *
 * @param {any} ctx
 * @returns {string}
 */
function pluginDirectory(ctx) {
  const candidates = [ctx?.location?.directory, process.cwd()];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

export default Plugin.define({
  id: "mystudio-annotations",

  /**
   * @param {any} ctx
   */
  async setup(ctx) {
    /** @type {Array<() => void | Promise<void>>} */
    const cleanups = [];

    /*
     * Start following `session.viewed` **before** anything can deliver.
     *
     * It is only a fallback now: delivery goes to the sessions that subscribed. The
     * timestamp signal still matters for a payload that arrives without a pin (an old
     * outbox record, a manual POST), so it stays subscribed rather than removed.
     */
    const viewed = createViewedRegistry();
    cleanups.push(trackViewedSessions(ctx, viewed, log));

    // A crashed MyStudio instance must not leave conversations "subscribed" to nothing.
    const pruned = await pruneDeadSubscriptions().catch(() => 0);
    if (pruned > 0) log("Pruned subscriptions of apps that are gone", { count: pruned });

    // ── 1. Inbox ────────────────────────────────────────────────────────────
    let ownEndpoint = "";
    if (PORT === null) {
      log("Invalid port configuration; inbox not started", {
        port: process.env.MYSTUDIO_INBOX_PORT,
      });
    } else {
      try {
        const inbox = await startInbox({ ctx, port: PORT, log, viewed });
        cleanups.push(() => inbox.close());
        ownEndpoint = `http://127.0.0.1:${inbox.port}`;
        log(`Inbox ready at ${ownEndpoint}/annotations`);
      } catch (error) {
        /*
         * Without an inbox a subscription cannot be honoured: the app would have nowhere to
         * post. So the tools are not offered either, and the reason is logged rather than
         * silently producing subscriptions that can never receive anything.
         */
        const message = error instanceof Error ? error.message : String(error);
        log("Inbox failed to start; subscription tools are disabled", { port: PORT, error: message });
      }
    }

    // ── 2. Subscription tools ───────────────────────────────────────────────
    if (ownEndpoint) {
      try {
        const tools = await registerTools(ctx, { pluginEndpoint: ownEndpoint, log });
        cleanups.push(() => tools.dispose());
        log("Subscription tools registered", { endpoint: ownEndpoint });
      } catch (error) {
        log("Could not register the subscription tools", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ── 3. Replay annotations queued while nothing was subscribed ───────────
    const directory = pluginDirectory(ctx);
    const dirs = outboxDirsFor(directory);
    if (dirs.length > 0 && ownEndpoint) {
      const drain = startOutboxDrain(ctx, dirs, { log, viewed, ownEndpoint });
      cleanups.push(() => drain.stop());
      log("File outbox replay started", { dirs });
    } else if (dirs.length === 0) {
      log("No working directory available; file outbox replay disabled");
    }

    return () => {
      for (const cleanup of cleanups) void cleanup();
      log("Plugin resources released");
    };
  },
});
