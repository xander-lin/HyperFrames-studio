/**
 * Delivery to **whichever conversations subscribed**, and to nobody else.
 *
 * ## Why there is no selection here
 *
 * This module used to be the place where "which conversation?" was answered, by handing the
 * annotation to a plugin that guessed. That guess is gone: a conversation subscribes from
 * inside itself (see the plugin's `mystudio_subscribe` tool), and this sink simply fans the
 * delivery out to the subscriptions it can see.
 *
 * Consequences worth stating:
 * - **zero subscribers is a normal state**, not an error: nothing has asked for this app's
 *   annotations yet. The record is queued so it is not lost, and the UI says so;
 * - **several subscribers get the same prompt**: that is the point — two conversations can
 *   be working on one project and both want to see what was annotated;
 * - a subscriber whose plugin this process cannot reach is reported, not silently dropped.
 */

import {
  addSubscription,
  subscriptionsForApp,
  type Subscription,
} from "@mystudio/protocol/node";
import { validateBundle } from "@mystudio/protocol";
import type {
  AnnotationBundle,
  DeliverOptions,
  DeliveryOutcome,
  DeliveryTarget,
  InboxPayload,
  PromptSink,
} from "@mystudio/protocol";
import { FileOutboxSink } from "@mystudio/protocol/node";

export interface SubscribedSinkOptions {
  /** This app's launch id; subscriptions are keyed by it. */
  readonly appId: string;
  readonly projectDir: string;
  /** Registry root (injectable for tests). Defaults to the real runtime directory. */
  readonly root?: string;
  /** Where to keep a delivery that no conversation asked for. */
  readonly outbox: FileOutboxSink;
  /** Per-request timeout. Loopback, so slower than this means the plugin is wedged. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** One delivery attempt to one subscriber. */
interface Attempt {
  readonly subscription: Subscription;
  readonly outcome: DeliveryOutcome;
}

export class SubscribedSink implements PromptSink {
  readonly name = "subscribers";

  constructor(private readonly options: SubscribedSinkOptions) {}

  async deliver(
    bundle: AnnotationBundle,
    prompt: string,
    deliverOptions: DeliverOptions = {},
  ): Promise<DeliveryOutcome> {
    const invalid = validateBundle(bundle);
    if (invalid) return { ok: false, code: "rejected", message: invalid };

    /*
     * Include subscriptions made for **earlier launches of this project**.
     *
     * A subscription is a statement about the project, not about one window: keying it only
     * by the launch id meant a restart silently left nobody subscribed (found.md F-098).
     */
    const all = await subscriptionsForApp(
      { appId: this.options.appId, projectDir: this.options.projectDir },
      this.options.root,
    );
    /*
     * An explicit pin narrows the fan-out to one subscriber.
     *
     * It cannot invent a destination: if the named session is not subscribed, there is no
     * endpoint to post to, and silently guessing one is the behaviour this design removed.
     */
    const pinned = deliverOptions.targetSessionID?.trim();
    const subscriptions = pinned ? all.filter((entry) => entry.sessionID === pinned) : all;

    if (subscriptions.length === 0) {
      /*
       * Nobody asked for these annotations.
       *
       * Queue instead of failing: the user drew something, and a missing subscription is a
       * setup step, not a reason to throw the work away. The reply says "queued", which the
       * panel shows verbatim — a bare "Sent" here would be a lie.
       */
      const queued = await this.queueWithIdentity(bundle, prompt);
      if (!queued.ok) return queued;
      return {
        ok: true,
        deliveredAt: queued.deliveredAt,
        detail: pinned
          ? `No conversation is subscribed as ${pinned}; saved to the outbox`
          : "No conversation is subscribed to this app yet; saved to the outbox",
      };
    }

    const attempts = await Promise.all(
      subscriptions.map((subscription) => this.post(subscription, bundle, prompt)),
    );

    const delivered = attempts.filter((attempt) => attempt.outcome.ok);
    const failed = attempts.filter((attempt) => !attempt.outcome.ok);
    const targets = delivered.map((attempt) => targetOf(attempt.subscription));

    if (delivered.length === 0) {
      /*
       * Every subscriber was unreachable. The plugin may simply be restarting, so the
       * delivery still goes to the outbox: losing the annotation because a process was
       * down for a second is not acceptable.
       */
      const queued = await this.queueWithIdentity(bundle, prompt);
      const reasons = failed
        .map((attempt) => `${attempt.subscription.sessionID}: ${messageOf(attempt.outcome)}`)
        .join("; ");
      if (!queued.ok) {
        return {
          ok: false,
          code: "unreachable",
          message: `No subscriber could be reached (${reasons}); queueing also failed: ${queued.message}`,
        };
      }
      return {
        ok: true,
        deliveredAt: queued.deliveredAt,
        detail: `No subscriber could be reached (${reasons}); saved to the outbox`,
      };
    }

    return {
      ok: true,
      deliveredAt: Date.now(),
      detail:
        failed.length === 0
          ? `Delivered to ${targets.length} conversation${targets.length === 1 ? "" : "s"}`
          : `Delivered to ${targets.length}; ${failed.length} unreachable`,
      ...(targets[0] ? { target: targets[0] } : {}),
      targets,
    };
  }

  /**
   * Queue a delivery, remembering which app instance produced it.
   *
   * Without the id, a record written before a restart can only be matched by project
   * directory — and two windows on one project are indistinguishable. Worse, the id is what
   * lets replay find **this** app's subscribers instead of guessing; a delivery with no
   * identity could never be routed and just sat in the outbox (found.md F-098).
   */
  private async queueWithIdentity(
    bundle: AnnotationBundle,
    prompt: string,
  ): Promise<DeliveryOutcome> {
    return this.options.outbox.deliver(bundle, prompt, {
      /* `appId` travels in the outbox record itself, via `FileOutboxSink`'s payload. */
      appId: this.options.appId,
    });
  }

  /** One POST to one subscriber's plugin inbox. */
  private async post(
    subscription: Subscription,
    bundle: AnnotationBundle,
    prompt: string,
  ): Promise<Attempt> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const payload: InboxPayload = {
      schemaVersion: 1,
      prompt,
      bundle,
      targetSessionID: subscription.sessionID,
    };

    try {
      const response = await doFetch(
        `${subscription.pluginEndpoint.replace(/\/+$/, "")}/annotations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          subscription,
          outcome: {
            ok: false,
            code: "rejected",
            message: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
          },
        };
      }
      return { subscription, outcome: { ok: true, deliveredAt: Date.now() } };
    } catch (error) {
      return {
        subscription,
        outcome: {
          ok: false,
          code: error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function targetOf(subscription: Subscription): DeliveryTarget {
  return {
    sessionID: subscription.sessionID,
    created: false,
    reason: "subscribed",
    ...(subscription.sessionTitle ? { title: subscription.sessionTitle } : {}),
  };
}

function messageOf(outcome: DeliveryOutcome): string {
  return outcome.ok ? "ok" : outcome.message;
}

/** Record a subscription whose app is this one. Used by tests and by import tooling. */
export { addSubscription };
