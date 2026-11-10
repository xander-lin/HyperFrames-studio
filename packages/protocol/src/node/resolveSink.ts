import type { AnnotationBundle } from "../annotation.js";
import type {
  DeliverOptions,
  DeliveryOutcome,
  PromptSink,
} from "../sink.js";
import { FileOutboxSink } from "./fileOutboxSink.js";
import { HttpSink } from "./httpSink.js";

/**
 * Combined channel: try the plugin inbox first, fall back to disk so nothing is
 * lost.
 *
 * This is the production default. In practice "delivery failed" almost always
 * means "OpenCode is not running", and the annotations the user just drew are
 * valuable — silently dropping them is unacceptable.
 */
export class FallbackSink implements PromptSink {
  readonly name: string;

  constructor(
    private readonly primary: PromptSink,
    private readonly fallback: PromptSink,
  ) {
    this.name = `${primary.name}+${fallback.name}`;
  }

  async deliver(
    bundle: AnnotationBundle,
    prompt: string,
    options: DeliverOptions = {},
  ): Promise<DeliveryOutcome> {
    const first = await this.primary.deliver(bundle, prompt, options);
    if (first.ok) return first;

    // "Rejected" is a content problem; another channel cannot fix it, so say so.
    if (first.code === "rejected") return first;

    const second = await this.fallback.deliver(bundle, prompt, options);
    if (second.ok) {
      return {
        ok: true,
        deliveredAt: second.deliveredAt,
        detail: `${this.primary.name} unavailable (${first.message}); queued in the outbox: ${second.detail ?? ""}`,
      };
    }
    return {
      ok: false,
      code: first.code,
      message: `${first.message}; queueing also failed: ${second.message}`,
    };
  }
}

export interface ResolveSinkOptions {
  /** Plugin inbox endpoint. Empty means "do not use the HTTP channel". */
  readonly inboxEndpoint?: string;
  /** Outbox directory. Empty means "no disk fallback". */
  readonly outboxDir?: string;
  /** Force one implementation (tests/demos). */
  readonly force?: PromptSink;
}

/**
 * Assemble the delivery channel from configuration.
 *
 * Three tiers: forced > HTTP + outbox > outbox only. Returns null when no channel
 * is available so the caller can report "delivery is not configured" explicitly
 * instead of pretending to succeed.
 */
export function resolveSink(options: ResolveSinkOptions): PromptSink | null {
  if (options.force) return options.force;

  const http = options.inboxEndpoint
    ? new HttpSink({ endpoint: options.inboxEndpoint })
    : null;
  const outbox = options.outboxDir ? new FileOutboxSink({ dir: options.outboxDir }) : null;

  if (http && outbox) return new FallbackSink(http, outbox);
  return http ?? outbox;
}
