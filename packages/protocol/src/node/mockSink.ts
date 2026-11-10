import type { AnnotationBundle } from "../annotation.js";
import type { DeliverOptions, DeliveryOutcome, PromptSink } from "../sink.js";
import { validateBundle } from "../sink.js";

/** One recorded delivery, for test assertions. */
export interface MockDelivery {
  readonly prompt: string;
  readonly bundle: AnnotationBundle;
  readonly at: number;
  /** The pin the caller asked for, if any. */
  readonly targetSessionID?: string;
  /** The app instance that produced it, if any. */
  readonly appId?: string;
}

/**
 * Test/dev delivery channel: keeps deliveries in memory and never fails.
 *
 * It is the executable form of the interface contract: every real implementation
 * must accept the same input and return the same result shape.
 */
export class MockSink implements PromptSink {
  readonly name = "mock";
  readonly deliveries: MockDelivery[] = [];
  /** When set, every subsequent delivery returns this failure. */
  failWith: DeliveryOutcome | null = null;

  async deliver(
    bundle: AnnotationBundle,
    prompt: string,
    options: DeliverOptions = {},
  ): Promise<DeliveryOutcome> {
    const invalid = validateBundle(bundle);
    if (invalid) return { ok: false, code: "rejected", message: invalid };
    if (this.failWith) return this.failWith;
    const at = Date.now();
    const targetSessionID = options.targetSessionID?.trim();
    const appId = options.appId?.trim();
    this.deliveries.push({
      prompt,
      bundle,
      at,
      ...(targetSessionID ? { targetSessionID } : {}),
      ...(appId ? { appId } : {}),
    });
    return {
      ok: true,
      deliveredAt: at,
      ...(targetSessionID
        ? { target: { sessionID: targetSessionID, created: false, reason: "pinned" } }
        : {}),
    };
  }

  get lastPrompt(): string | null {
    return this.deliveries.at(-1)?.prompt ?? null;
  }
}
