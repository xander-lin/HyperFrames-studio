/**
 * The agent-facing side of the subscription model: one tool, and the logic behind it.
 *
 * ## Why a tool, and not a setting in MyStudio
 *
 * The app cannot enumerate OpenCode conversations, so it cannot offer a picker without
 * receiving a list from someone else — which is how the guessing started. The conversation
 * itself is the only place that knows it wants these annotations, and an agent in that
 * conversation can act. So subscribing is an **action taken inside the conversation**.
 *
 * ## What "subscribe" means
 *
 * One record: this OpenCode session wants the annotations of one MyStudio app instance.
 * - several sessions may subscribe to the same app; each receives every delivery;
 * - a session may subscribe to several apps (two decks open in two windows);
 * - the record names **this plugin's** inbox, because the app has no way to discover it and
 *   a plugin that had to take a non-default port is still reachable this way.
 *
 * ## Why the app is chosen by id
 *
 * A presence record is per **launch**, so two windows showing the same project are two
 * different apps. When the choice is ambiguous the tool refuses and lists the candidates:
 * picking one silently is the exact failure the subscription model exists to avoid.
 */

import {
  addSubscription,
  listApps,
  listSubscriptions,
  pruneDeadSubscriptions,
  removeSubscription,
  subscriptionsOfSession,
} from "@mystudio/protocol/node";

/**
 * A short label for the app, as the agent will see it in a result.
 *
 * @param {import("@mystudio/protocol/node").AppPresence} app
 * @returns {string}
 */
export function describeApp(app) {
  return `${app.projectName} — ${app.projectDir}`;
}

/**
 * The app records a session may subscribe to, with how many sessions already did.
 *
 * @param {string} [root]
 * @param {number} [now]
 * @returns {Promise<Array<{app: import("@mystudio/protocol/node").AppPresence, subscribers: number}>>}
 */
export async function appsForAgent(root, now = Date.now()) {
  // Clean first: a killed instance must not stay on the menu.
  await pruneDeadSubscriptions(root, now);
  const apps = await listApps(root, now);
  const rows = [];
  for (const app of apps) {
    rows.push({ app, subscribers: (await listSubscriptions(app.appId, root)).length });
  }
  return rows;
}

/**
 * Choose the app to subscribe to.
 *
 * Rules, in order:
 * 1. `appId` given → use it if it is live, otherwise say which ones exist;
 * 2. exactly one live app → use it, no ceremony;
 * 3. several live apps, exactly one for this session's directory → use that one;
 * 4. otherwise **refuse** and list the candidates.
 *
 * Returning a candidate list instead of a guess is deliberate: a wrong subscription is
 * invisible until the user notices prompts arriving in the wrong conversation.
 */
export function chooseApp(apps, options) {
  const wanted = options.appId?.trim();
  if (wanted) {
    const found = apps.find((app) => app.appId === wanted);
    return found
      ? { ok: true, app: found }
      : { ok: false, reason: `No running app has id ${wanted}`, candidates: [...apps] };
  }

  if (apps.length === 1) {
    const only = apps[0];
    return only ? { ok: true, app: only } : { ok: false, reason: "No app is running", candidates: [] };
  }

  if (apps.length === 0) {
    return {
      ok: false,
      reason: "No MyStudio app is running. Start one (or open a project) and try again.",
      candidates: [],
    };
  }

  const directory = options.sessionDirectory?.replace(/[\\/]+$/, "") ?? "";
  if (directory) {
    const matching = apps.filter((app) => app.projectDir.replace(/[\\/]+$/, "") === directory);
    if (matching.length === 1) {
      const only = matching[0];
      if (only) return { ok: true, app: only };
    }
  }

  return {
    ok: false,
    reason:
      "More than one app is running, so which one to subscribe to is ambiguous. " +
      "Pass appId — one of the candidates below.",
    candidates: [...apps],
  };
}

/**
 * Subscribe one session to one app. Idempotent: subscribing twice rewrites the record.
 *
 * @param {{
 *   root?: string,
 *   appId?: string | null,
 *   sessionID: string,
 *   sessionDirectory?: string | null,
 *   sessionTitle?: string | null,
 *   pluginEndpoint: string,
 *   now?: number,
 * }} options
 * @returns {Promise<
 *   {ok: true, app: import("@mystudio/protocol/node").AppPresence, subscription: object} |
 *   {ok: false, reason: string, candidates: readonly object[]}
 * >}
 */
export async function subscribeSession(options) {
  const now = options.now ?? Date.now();
  const apps = await listApps(options.root, now);
  const choice = chooseApp(apps, {
    appId: options.appId ?? null,
    sessionDirectory: options.sessionDirectory ?? null,
  });
  if (!choice.ok) return choice;

  /** @type {import("@mystudio/protocol/node").Subscription} */
  const subscription = {
    version: 1,
    appId: choice.app.appId,
    projectDir: choice.app.projectDir,
    sessionID: options.sessionID,
    pluginEndpoint: options.pluginEndpoint,
    createdAt: now,
    ...(options.sessionTitle?.trim() ? { sessionTitle: options.sessionTitle.trim() } : {}),
  };
  await addSubscription(subscription, options.root);
  return { ok: true, app: choice.app, subscription };
}

/**
 * Remove every subscription this session holds, or just the one for `appId`.
 *
 * @param {{root?: string, sessionID: string, appId?: string | null}} options
 * @returns {Promise<number>}
 */
export async function unsubscribeSession(options) {
  const held = await subscriptionsOfSession(options.sessionID, options.root);
  const wanted = options.appId?.trim();
  const targets = wanted ? held.filter((entry) => entry.appId === wanted) : held;
  for (const entry of targets) {
    await removeSubscription(entry.appId, entry.sessionID, options.root);
  }
  return targets.length;
}
