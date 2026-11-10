/**
 * The agent-facing tools: list running apps, subscribe, unsubscribe.
 *
 * ## Why the agent and not the app
 *
 * A conversation is the only place that knows it wants a project's annotations. The app
 * cannot even see which conversations exist. So subscription is declared from inside the
 * conversation by an agent action, and the app simply delivers to whoever declared.
 *
 * ## Why the results are prose
 *
 * These return text, not machine data: the caller is a language model that has to decide
 * what to do next (subscribe now, ask the user which window, or start the app). A JSON blob
 * would make it guess at meaning; a sentence does not.
 *
 * ## Why `execute` returns a Promise and not an Effect
 *
 * The plugin is loaded through the `@opencode/plugin` **promise** entry point (the default
 * export), whose `Tool.Info.execute` is declared as `=> Promise<Tool.Result>`. Returning an
 * `Effect` type-checks against `@opencode/schema/tool`'s Effect-shaped info, but the host's
 * Code Mode runner does `result.then(...)` and dies with "then is not a function"
 * (found.md F-088). Plain async functions are the shape this loader actually calls.
 */

import {
  appsForAgent,
  chooseApp,
  describeApp,
  subscribeSession,
  unsubscribeSession,
} from "./subscriptions.js";
import { listApps, subscriptionsOfSession } from "@mystudio/protocol/node";

/** JSON Schema for the optional `appId` argument. */
const APP_ID_SCHEMA = {
  type: "object",
  properties: {
    appId: {
      type: "string",
      description:
        "Identity of the MyStudio app to act on. Omit when only one app is running.",
    },
  },
  additionalProperties: false,
};

/** One `content` item: plain text, which every host renders. */
function text(value) {
  return [{ type: "text", text: value }];
}

/**
 * Resolve the session's directory, used to disambiguate between apps.
 *
 * Failure is normal (session just created, host without `get`); the choice then falls back
 * to "exactly one app, or refuse".
 */
async function sessionDirectory(ctx, sessionID) {
  if (typeof ctx?.session?.get !== "function") return null;
  try {
    const response = await ctx.session.get({ sessionID });
    const session = response?.data ?? response;
    const directory = session?.location?.directory;
    return typeof directory === "string" ? directory : null;
  } catch {
    return null;
  }
}

async function sessionTitle(ctx, sessionID) {
  if (typeof ctx?.session?.get !== "function") return null;
  try {
    const response = await ctx.session.get({ sessionID });
    const session = response?.data ?? response;
    const title = session?.title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Register the tools with the host.
 *
 * `transform` may be called again on hot reload, so the callback is written to be
 * idempotent: it only touches its own tool names.
 *
 * @param {any} ctx
 * @param {{root?: string, pluginEndpoint: string, log?: (msg: string, detail?: unknown) => void}} options
 * @returns {Promise<{dispose: () => Promise<void>}>}
 */
export async function registerTools(ctx, options) {
  const log = options.log ?? (() => {});
  const root = options.root;
  const endpoint = options.pluginEndpoint;

  return ctx.tool.transform((editor) => {
    editor.add({
      name: "mystudio_apps",
      description:
        "List the MyStudio apps currently running on this machine, with the project each one is " +
        "editing and how many conversations are already subscribed. Use it before subscribing " +
        "when more than one app may be open.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
          const rows = await appsForAgent(root);
          if (rows.length === 0) {
            return {
              content: text(
                "No MyStudio app is running. Start one (or open a project in it), then try again.",
              ),
            };
          }
          const lines = ["Running MyStudio apps:"];
          for (const { app, subscribers } of rows) {
            lines.push(
              `- appId: ${app.appId}`,
              `  project: ${describeApp(app)}`,
              `  endpoint: ${app.endpoint}`,
              `  conversations subscribed: ${subscribers}`,
            );
          }
          lines.push(
            "",
            "Subscribe to one with mystudio_subscribe, passing its appId when more than one is listed.",
          );
          return { content: text(lines.join("\n")) };
      },
    });

    editor.add({
      name: "mystudio_subscribe",
      description:
        "Subscribe this conversation to a running MyStudio app, so annotations drawn there are " +
        "delivered into this conversation. Several conversations may subscribe to the same app; " +
        "each receives every delivery.",
      input: APP_ID_SCHEMA,
      execute: async (input, context) => {
          const sessionID = String(context.sessionID);
          const directory = await sessionDirectory(ctx, sessionID);
          const title = await sessionTitle(ctx, sessionID);

          const result = await subscribeSession({
            root,
            appId: typeof input?.appId === "string" ? input.appId : null,
            sessionID,
            sessionDirectory: directory,
            sessionTitle: title,
            pluginEndpoint: endpoint,
          });

          if (result.ok) {
            log("Session subscribed", {
              sessionID,
              appId: result.app.appId,
              project: result.app.projectDir,
            });
            return {
              content: text(
                `Subscribed this conversation to ${describeApp(result.app)}.\n` +
                  "Annotations drawn in that app will arrive here. " +
                  "Use mystudio_unsubscribe to stop.",
              ),
            };
          }

          const lines = [result.reason];
          if (result.candidates.length > 0) {
            lines.push("", "Candidates:");
            for (const app of result.candidates) {
              lines.push(`- appId: ${app.appId} — ${describeApp(app)}`);
            }
            lines.push("", "Call mystudio_subscribe again with one of these appIds.");
          }
          return { content: text(lines.join("\n")) };
      },
    });

    editor.add({
      name: "mystudio_unsubscribe",
      description:
        "Stop delivering a MyStudio app's annotations into this conversation. Without appId, " +
        "removes every MyStudio subscription this conversation holds.",
      input: APP_ID_SCHEMA,
      execute: async (input, context) => {
          const sessionID = String(context.sessionID);
          const removed = await unsubscribeSession({
            root,
            sessionID,
            appId: typeof input?.appId === "string" ? input.appId : null,
          });
          if (removed === 0) {
            return { content: text("This conversation was not subscribed to any MyStudio app.") };
          }
          log("Session unsubscribed", { sessionID, removed });
          return {
            content: text(
              `Removed ${removed} subscription${removed === 1 ? "" : "s"}. ` +
                "Annotations will no longer be delivered here.",
            ),
          };
      },
    });
  });
}

/** The app ids a session is subscribed to, for diagnostics and tests. */
export async function subscribedAppIds(root, sessionID) {
  const held = await subscriptionsOfSession(sessionID, root);
  return held.map((entry) => entry.appId);
}

/** Applications currently advertising themselves; re-exported for the inbox. */
export { listApps, chooseApp };
