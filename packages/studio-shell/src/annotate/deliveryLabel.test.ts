import { describe, expect, it } from "vitest";
import type { DeliveryOutcome } from "@mystudio/protocol";
import { describeOutcome } from "./deliveryLabel.js";

/**
 * What the panel says after sending.
 *
 * The destination is part of the result: the layer cannot choose a session, so the only
 * way the user can tell whether the guess was right is being told **where** the prompt
 * went and **why** that session was picked.
 */

describe("describeOutcome", () => {
  it("renders nothing before anything was sent", () => {
    expect(describeOutcome(null)).toBeNull();
  });

  it("names the session, not just 'Sent'", () => {
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      target: { sessionID: "ses_abc", title: "AVL rotations", created: false, reason: "last-viewed" },
    };
    const label = describeOutcome(outcome);
    expect(label?.text).toBe("Sent · AVL rotations");
    expect(label?.title).toContain("ses_abc");
  });

  it("falls back to the id when the session has no title", () => {
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      target: { sessionID: "ses_abc", created: false, reason: "pinned" },
    };
    expect(describeOutcome(outcome)?.text).toBe("Sent · ses_abc");
  });

  it("explains why that session was chosen", () => {
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      target: { sessionID: "ses_new", created: true, reason: "created" },
    };
    expect(describeOutcome(outcome)?.title).toContain("new one was created");
  });

  it("says how many conversations received a fan-out delivery", () => {
    /*
     * Delivery goes to every subscriber, so "Sent" alone would hide a second (possibly
     * forgotten) subscription receiving the same prompt.
     */
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      detail: "Delivered to 2 conversations",
      targets: [
        { sessionID: "ses_a", title: "AVL rotations", created: false, reason: "subscribed" },
        { sessionID: "ses_b", title: "Notes", created: false, reason: "subscribed" },
      ],
    };
    const label = describeOutcome(outcome);
    expect(label?.text).toBe("Sent to 2 conversations");
    expect(label?.title).toContain("AVL rotations");
    expect(label?.title).toContain("Notes");
  });

  it("explains a subscription as the reason", () => {
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      target: { sessionID: "ses_a", created: false, reason: "subscribed" },
    };
    expect(describeOutcome(outcome)?.title).toContain("subscribed to this app");
  });

  it("says 'Queued' when the delivery only reached the outbox", () => {
    /*
     * A queued record has no destination yet: the plugin picks one when it drains. Calling
     * that "Sent" would claim something that has not happened.
     */
    const outcome: DeliveryOutcome = {
      ok: true,
      deliveredAt: 1,
      detail: "queued in the outbox: /p/.mystudio/outbox/x.json",
    };
    expect(describeOutcome(outcome)?.text).toBe("Queued");
  });

  it("shows the failure reason verbatim, so the user can act on it", () => {
    const outcome: DeliveryOutcome = {
      ok: false,
      code: "unreachable",
      message: "Cannot reach the inbox: ECONNREFUSED",
    };
    const label = describeOutcome(outcome);
    expect(label?.text).toBe("Failed");
    expect(label?.title).toContain("ECONNREFUSED");
  });
});
