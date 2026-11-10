/**
 * How a delivery outcome is worded in the prompt panel.
 *
 * ## Why "Sent" is not enough
 *
 * The plugin decides which OpenCode session receives a prompt (see
 * `sessionTarget.js`): the layer cannot see OpenCode's windows, so it cannot choose. That
 * makes the destination part of the **result**: an annotation delivered into a
 * conversation the user is not watching is wasted, and no amount of green text saying
 * "Sent" lets them notice.
 *
 * So the label names the session, and the hover text states why that session was chosen —
 * `pinned`, `last-viewed`, `most-recently-viewed` or `created` — because "why" is what
 * tells the user whether the guess was right.
 */

import type { DeliveryOutcome } from "@mystudio/protocol";

export interface OutcomeLabel {
  /** Short text shown next to "Prompt". */
  readonly text: string;
  /** Hover text: the full destination and the reason. */
  readonly title: string;
}

/** Why a session was chosen, in words. */
function reasonText(reason: string): string {
  switch (reason) {
    case "subscribed":
      return "that conversation subscribed to this app";
    case "pinned":
      return "you pinned this session";
    case "last-viewed":
      return "it is the session you looked at most recently";
    case "most-recently-viewed":
      return "it was the most recently viewed session in this project";
    case "created":
      return "no session matched, so a new one was created";
    default:
      return reason || "the plugin chose it";
  }
}

/**
 * Word one outcome.
 *
 * `null` means "no delivery yet", which must render nothing at all rather than a neutral
 * message: an idle panel with "Ready" on it is noise.
 */
export function describeOutcome(outcome: DeliveryOutcome | null): OutcomeLabel | null {
  if (!outcome) return null;

  if (!outcome.ok) {
    return {
      text: "Failed",
      title: outcome.message,
    };
  }

  /*
   * Fan-out: a delivery may reach several conversations at once.
   *
   * Said explicitly rather than showing only the first, because "two conversations both got
   * this" is a fact the user needs — it is how they notice a subscription they had forgotten.
   */
  const targets = outcome.targets ?? [];
  if (targets.length > 1) {
    const names = targets.map((target) => target.title ?? target.sessionID).join(", ");
    return {
      text: `Sent to ${targets.length} conversations`,
      title: `${names}\n${outcome.detail ?? ""}`.trim(),
    };
  }

  const target = targets[0] ?? outcome.target;
  if (!target) {
    /*
     * A queued delivery has no destination yet — the outbox record is written, and the
     * plugin picks a session when it drains. Saying so is more useful than a bare "Sent",
     * which would imply it already landed in a conversation.
     */
    return {
      text: "Queued",
      title: outcome.detail ?? "Saved to the outbox; the plugin will deliver it when it runs",
    };
  }

  const name = target.title ?? target.sessionID;
  return {
    text: `Sent · ${name}`,
    title: `${name}\n${target.sessionID}\nChosen because ${reasonText(target.reason)}`,
  };
}
