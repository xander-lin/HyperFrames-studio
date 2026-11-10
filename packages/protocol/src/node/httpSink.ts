import type { AnnotationBundle } from "../annotation.js";
import type {
  DeliverOptions,
  DeliveryOutcome,
  DeliveryTarget,
  InboxPayload,
  PromptSink,
} from "../sink.js";
import { validateBundle } from "../sink.js";

/**
 * Deliver to the inbox HTTP server that ships with the OpenCode plugin.
 *
 * That inbox is a **very small** service: it only receives annotations and turns
 * them into OpenCode session messages. It never parses the prompt text and never
 * touches a model, so a plugin rewrite only ever requires changes here.
 */
export interface HttpSinkOptions {
  /** Base URL of the plugin inbox, e.g. `http://127.0.0.1:47812`. */
  readonly endpoint: string;
  /** Per-request timeout in milliseconds. Default 8s — loopback, so slower means it is down. */
  readonly timeoutMs?: number;
  /** Injection point for tests. */
  readonly fetchImpl?: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class HttpSink implements PromptSink {
  readonly name = "http";

  constructor(private readonly options: HttpSinkOptions) {}

  async deliver(
    bundle: AnnotationBundle,
    prompt: string,
    options: DeliverOptions = {},
  ): Promise<DeliveryOutcome> {
    const invalid = validateBundle(bundle);
    if (invalid) return { ok: false, code: "rejected", message: invalid };

    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const targetSessionID = options.targetSessionID?.trim();
    const appId = options.appId?.trim();
    const payload: InboxPayload = {
      schemaVersion: 1,
      prompt,
      bundle,
      ...(targetSessionID ? { targetSessionID } : {}),
      ...(appId ? { appId } : {}),
    };

    try {
      const response = await doFetch(`${this.options.endpoint.replace(/\/+$/, "")}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        /*
         * The plugin answers with **which session it chose**. Keep it: it is the only
         * way the user can find out where the annotation went, and "Sent" without a
         * destination cannot be checked.
         */
        const body: unknown = await response.json().catch(() => null);
        const target = parseTarget(body);
        return {
          ok: true,
          deliveredAt: Date.now(),
          detail: `HTTP ${response.status}`,
          ...(target ? { target } : {}),
        };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "unauthorized", message: `Inbox refused access (HTTP ${response.status})` };
      }
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        code: "rejected",
        message: `Inbox rejected the request (HTTP ${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, code: "timeout", message: `Inbox did not respond within ${timeoutMs}ms` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "unreachable", message: `Cannot reach the inbox: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read the plugin's answer to "which session did this go to".
 *
 * Structural, not `instanceof`: the body arrives as parsed JSON. Every field is checked
 * because a malformed answer must degrade to "Sent, destination unknown" rather than
 * failing a delivery that actually succeeded.
 */
export function parseTarget(value: unknown): DeliveryTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sessionID = record["sessionID"];
  const reason = record["reason"];
  if (typeof sessionID !== "string" || sessionID === "") return null;
  if (typeof reason !== "string" || reason === "") return null;
  const title = record["title"];
  return {
    sessionID,
    created: record["created"] === true,
    reason,
    ...(typeof title === "string" && title !== "" ? { title } : {}),
  };
}
