/**
 * Session selection: deliver the annotation into **the session the user is looking
 * at**.
 *
 * ## Why this needs its own logic
 *
 * OpenCode can have several windows open, but they **share one server process**, and
 * the plugin runs inside it. The official docs say of `ctx.location`:
 *
 * > This is the plugin instance's location, not the location of every session
 * > it can access or event it receives.
 *
 * In other words a server plugin **cannot see** which window is focused. Guessing by
 * "most recently updated" goes wrong: any background session that receives an event
 * gets a newer `updated`, and the guess drops the annotation into a conversation the
 * user is not watching.
 *
 * ## The right signal: `time.viewed`
 *
 * `Session.Info.time` has three timestamps:
 * - `created` / `updated`: when the session was created / written to.
 * - `viewed`: **when the user last looked at this session**.
 *
 * Observed on this machine (50 sessions): `viewed` and `updated` differed in 13 of 13
 * cases, so it is an independent field rather than a copy. Sorting all sessions by
 * `viewed` descending put the two windows that were open side by side at the top.
 * That is the reliable "which one is the user looking at" signal.
 *
 * ## Selection order
 *
 * 1. The payload named a session — use it (do not guess when the user pinned one).
 * 2. **The session the user viewed most recently, live.** `session.viewed` is subscribed
 *    in `viewedRegistry.js`; this is a fact rather than a timestamp comparison.
 * 3. Among sessions in the same directory that have a model, the newest `viewed` — the
 *    fallback for a plugin that started after the user opened their window.
 * 4. Only when there is none, create one, inheriting the user's default model/agent.
 *
 * The chosen session's **title** is returned too. "Sent" without a destination cannot be
 * checked; the user has to be able to see which conversation received the prompt.
 */

/**
 * @typedef {object} SessionLike
 * @property {string} id
 * @property {{directory?: string} | undefined} [location]
 * @property {{id?: string, providerID?: string} | null} [model]
 * @property {{created?: number, updated?: number, viewed?: number}} [time]
 * @property {string} [title]
 */

/** How old a `viewed` timestamp may be and still count as "probably open". */
export const FRESH_MS = 12 * 60 * 60 * 1000;

/**
 * Strip trailing separators so `/a/b/` and `/a/b` are not treated as two directories.
 *
 * @param {unknown} dir
 * @returns {string}
 */
export function normalizeDir(dir) {
  if (typeof dir !== "string") return "";
  return dir.replace(/[\\/]+$/, "");
}

/**
 * When the user last viewed the session. Falls back to `updated`, then 0.
 *
 * Why not `viewed ?? 0`: older sessions may have no `viewed`, and `updated` is far
 * more useful than 0 there — one step back beats treating every old session as
 * "never seen".
 *
 * @param {SessionLike} session
 * @returns {number}
 */
export function viewedAt(session) {
  const time = session?.time;
  const viewed = time?.viewed;
  if (typeof viewed === "number" && Number.isFinite(viewed)) return viewed;
  const updated = time?.updated;
  return typeof updated === "number" && Number.isFinite(updated) ? updated : 0;
}

/**
 * Whether the session has a usable model — an empty session cannot be prompted.
 *
 * @param {SessionLike} session
 * @returns {boolean}
 */
function isUsable(session) {
  return Boolean(session && typeof session.id === "string" && session.model && session.model.id);
}

/**
 * Pick the session the user is most likely looking at.
 *
 * Pure, so the selection rules can be tested without an OpenCode context.
 *
 * @param {readonly SessionLike[]} sessions
 * @param {string} projectDir
 * @param {number} [now] current time, used to decide whether `viewed` is fresh
 * @returns {SessionLike | null}
 */
export function pickBestSession(sessions, projectDir, now = Date.now()) {
  const wanted = normalizeDir(projectDir);
  if (!wanted) return null;

  const usable = sessions.filter(
    (session) => isUsable(session) && normalizeDir(session.location?.directory) === wanted,
  );
  if (usable.length === 0) return null;

  /*
   * Primary ordering: whether it was **recently viewed**.
   *
   * Why not simply take the largest `viewed`: that may be ancient. Such a session was
   * "seen once", not "open now". A grace period (12 hours by default, one working day)
   * is allowed, inside which `viewed` decides, and outside which ordering falls back
   * to `updated` — so a session from last week does not outrank one used hours ago.
   */
  const fresh = usable.filter((session) => {
    const viewed = session.time?.viewed;
    return typeof viewed === "number" && now - viewed >= 0 && now - viewed < FRESH_MS;
  });

  const pool = fresh.length > 0 ? fresh : usable;
  const sorted = [...pool].sort((a, b) => {
    const delta = viewedAt(b) - viewedAt(a);
    if (delta !== 0) return delta;
    // Break ties with `updated` so the order is stable and reproducible.
    return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
  });
  return sorted[0] ?? null;
}

/**
 * @typedef {object} ResolvedTarget
 * @property {string} sessionID
 * @property {string} [title]
 * @property {boolean} created
 * @property {"pinned" | "last-viewed" | "most-recently-viewed" | "created"} reason
 */

/**
 * Resolve where to deliver.
 *
 * @param {any} ctx OpenCode plugin context
 * @param {string} projectDir project directory
 * @param {string} [explicitSessionID] session pinned by the payload
 * @param {{lastViewedSessionID?: string | null}} [hints] live "user is looking at this"
 * @returns {Promise<ResolvedTarget>}
 */
export async function resolveTargetSession(ctx, projectDir, explicitSessionID, hints = {}) {
  const all = await listSessions(ctx, projectDir);

  /*
   * 1. A pinned session wins, and its directory is not validated.
   *
   * Delivery is now fanned out to **subscribers**, and every such request carries a pin.
   * Looking the pin up in `all` would be wrong here: that list is filtered by this app's
   * project directory, while the pin may name a session elsewhere, or one that fell outside
   * the page. So the pin is fetched by id first; only if that fails does anything else run.
   */
  if (typeof explicitSessionID === "string" && explicitSessionID) {
    const known = all.find((session) => session?.id === explicitSessionID);
    if (known) return targetOf(known, "pinned");
    const fetched = await fetchSession(ctx, explicitSessionID);
    if (fetched) return targetOf(fetched, "pinned");
    // If the list was unavailable, still honour the choice; if it was available and the
    // session is missing, it was deleted and auto-selection takes over.
    if (all.length === 0) {
      return { sessionID: explicitSessionID, created: false, reason: "pinned" };
    }
  }

  // 2. The session the user is looking at, from the live `session.viewed` signal.
  const viewed = typeof hints.lastViewedSessionID === "string" ? hints.lastViewedSessionID : "";
  if (viewed) {
    const known = all.find((session) => session?.id === viewed);
    if (known && isUsable(known) && normalizeDir(known.location?.directory) === normalizeDir(projectDir)) {
      return targetOf(known, "last-viewed");
    }
    // The event may arrive for a session the list page does not contain (older than the
    // page limit, or filtered differently). Ask for that one directly rather than losing
    // the strongest signal we have.
    if (!known) {
      const fetched = await fetchSession(ctx, viewed);
      if (
        fetched &&
        isUsable(fetched) &&
        normalizeDir(fetched.location?.directory) === normalizeDir(projectDir)
      ) {
        return targetOf(fetched, "last-viewed");
      }
    }
  }

  // 3. The most recently viewed session in the same directory.
  const best = pickBestSession(all, projectDir);
  if (best) return targetOf(best, "most-recently-viewed");

  // 4. Create one, inheriting the user's defaults.
  const created = await ctx.session.create({
    title: "MyStudio annotations",
    location: { directory: projectDir },
    ...(await readDefaultModel(ctx)),
    ...(await readDefaultAgent(ctx)),
  });
  const id = created?.id ?? created?.data?.id;
  if (typeof id !== "string") {
    throw new Error("Cannot create a session: OpenCode returned no session id");
  }
  return { sessionID: id, created: true, reason: "created" };
}

/**
 * Sessions in the project's directory.
 *
 * Two attempts, in this order:
 *
 * 1. **Server-side filter** by `directory`. Filtering only in this process meant the
 *    project's sessions had to appear in the first page of an unfiltered list; on a
 *    long-lived installation they do not, and the lookup silently found nothing.
 * 2. If that yields nothing, an unfiltered page filtered here. The input's `directory`
 *    semantics belong to the host; when it means something narrower than
 *    `location.directory` (a worktree, say), an empty answer would otherwise create a new
 *    session on every delivery.
 *
 * Failure to list is not failure to deliver: an empty result falls through to "create a
 * session", which is a working outcome, not an error.
 *
 * @param {any} ctx
 * @param {string} projectDir
 * @returns {Promise<SessionLike[]>}
 */
async function listSessions(ctx, projectDir) {
  const scoped = await listOnce(ctx, { directory: projectDir, limit: 100 });
  if (scoped.length > 0) return scoped;
  return listOnce(ctx, { limit: 100 });
}

/**
 * Conversations the user could bind to, for the picker.
 *
 * Returns only sessions **in this project's directory**: binding across projects would put
 * a Hyperframes prompt into an unrelated conversation. The directory is included anyway so
 * the picker can show it when a session was moved.
 *
 * Sorted by "most likely to be the one you mean": last viewed first, then last written.
 * `archived` sessions are dropped — binding to something the user has filed away is a
 * promise that will not be kept.
 *
 * @param {any} ctx
 * @param {string} projectDir
 * @returns {Promise<Array<{id: string, title: string, directory: string, updatedAt: number, viewedAt: number | null}>>}
 */
export async function listBindableSessions(ctx, projectDir) {
  const wanted = normalizeDir(projectDir);
  if (!wanted) return [];

  const sessions = await listSessions(ctx, projectDir);
  const seen = new Set();
  const summaries = [];

  for (const session of sessions) {
    if (!session || typeof session.id !== "string") continue;
    if (session.time?.archived) continue;
    if (normalizeDir(session.location?.directory) !== wanted) continue;
    if (seen.has(session.id)) continue;
    seen.add(session.id);

    const viewed = session.time?.viewed;
    summaries.push({
      id: session.id,
      title: typeof session.title === "string" && session.title.trim() ? session.title.trim() : session.id,
      directory: session.location?.directory ?? "",
      updatedAt: typeof session.time?.updated === "number" ? session.time.updated : 0,
      viewedAt: typeof viewed === "number" && Number.isFinite(viewed) ? viewed : null,
    });
  }

  summaries.sort((a, b) => {
    const byView = (b.viewedAt ?? 0) - (a.viewedAt ?? 0);
    if (byView !== 0) return byView;
    return b.updatedAt - a.updatedAt;
  });

  return summaries;
}

/**
 * One `session.list` call, normalised across the two response shapes.
 *
 * @param {any} ctx
 * @param {{directory?: string, limit?: number}} input
 * @returns {Promise<SessionLike[]>}
 */
async function listOnce(ctx, input) {
  try {
    const page = await ctx.session.list(input);
    // v2 returns `{ data, cursor }`; an older shape returned the array directly.
    return Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : [];
  } catch {
    return [];
  }
}

/**
 * A resolved target, carrying the title when the session reports one.
 *
 * @param {SessionLike} session
 * @param {ResolvedTarget["reason"]} reason
 * @returns {ResolvedTarget}
 */
function targetOf(session, reason) {
  const title = typeof session.title === "string" && session.title.trim() ? session.title.trim() : undefined;
  return {
    sessionID: session.id,
    created: false,
    reason,
    ...(title ? { title } : {}),
  };
}

/**
 * Fetch one session by id, or null when that is not possible.
 *
 * @param {any} ctx
 * @param {string} sessionID
 * @returns {Promise<SessionLike | null>}
 */
async function fetchSession(ctx, sessionID) {
  if (typeof ctx?.session?.get !== "function") return null;
  try {
    const response = await ctx.session.get({ sessionID });
    const session = response?.data ?? response;
    return session && typeof session === "object" ? session : null;
  } catch {
    return null;
  }
}

/**
 * Read the user's default model.
 *
 * The shape conversion is necessary: `model.default()` returns a `Model.Info` (with
 * `modelID`) while `session.create` needs a `Model.Ref` (`{ id, providerID }`).
 * Passing it through produces a session that "has a model" but cannot be used.
 *
 * @param {any} ctx
 * @returns {Promise<{model?: {id: string, providerID: string, variant?: string}}>}
 */
async function readDefaultModel(ctx) {
  try {
    const response = await ctx.model.default();
    const info = response?.data ?? response;
    if (!info || typeof info !== "object") return {};

    const modelID = typeof info.modelID === "string" ? info.modelID : info.id;
    const providerID = info.providerID;
    if (typeof modelID !== "string" || !modelID) return {};
    if (typeof providerID !== "string" || !providerID) return {};

    /** @type {{id: string, providerID: string, variant?: string}} */
    const model = { id: modelID, providerID };
    if (typeof info.variant === "string" && info.variant) model.variant = info.variant;
    return { model };
  } catch {
    return {};
  }
}

/**
 * Read a default agent so a new session resembles the user's usual setup. Empty when
 * unavailable.
 *
 * @param {any} ctx
 * @returns {Promise<{agent?: string}>}
 */
async function readDefaultAgent(ctx) {
  try {
    const response = await ctx.agent.list();
    const agents = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : [];
    const preferred = agents.find(
      (agent) => agent && agent.mode !== "subagent" && typeof agent.id === "string",
    );
    return preferred ? { agent: preferred.id } : {};
  } catch {
    return {};
  }
}
