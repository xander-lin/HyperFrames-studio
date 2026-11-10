import type { AnnotationBundle } from "./annotation.js";

/**
 * Which conversation the delivery is meant for, as reported **after** it landed.
 *
 * The plugin owns the selection (only it can see OpenCode's sessions), but the user has
 * to be able to see the outcome: an annotation delivered into a conversation the user is
 * not looking at is lost work, and "Sent" alone does not say where.
 */
export interface DeliveryTarget {
  /** OpenCode session id (`ses_…`). */
  readonly sessionID: string;
  /** Human title of that session, when the plugin could read it. */
  readonly title?: string;
  /** Whether the plugin had to create a session because none matched. */
  readonly created: boolean;
  /**
   * Why this session: `pinned` (the caller named it), `last-viewed` (the live
   * `session.viewed` signal), `most-recently-viewed` (the list fallback), or `created`.
   */
  readonly reason: string;
}



/**
 * Optional routing for one delivery.
 *
 * Absent everything means "let the plugin decide", which is the normal case. The field
 * exists so an explicit pin is possible at all: without it, a delivery can only ever be
 * auto-routed, and a wrong guess has no correction short of switching windows.
 */
export interface DeliverOptions {
  /** Force one session, by id. Deliberately not validated against a project directory. */
  readonly targetSessionID?: string;
  /**
   * Which app instance is delivering.
   *
   * Carried into the outbox record so a replay after a restart can find **that** app's
   * subscribers. Without it a queued delivery has no identity and can only be matched by
   * project directory — which cannot tell two windows apart, and in practice left the record
   * unroutable (found.md F-098).
   */
  readonly appId?: string;
}

/**
 * Delivery result. Failure is expressed as a value rather than a thrown error:
 * it is a normal branch (the plugin is not running, the port is closed) and the
 * caller must show the user a message instead of crashing a promise.
 */
export type DeliveryOutcome =
  | {
      readonly ok: true;
      readonly deliveredAt: number;
      readonly detail?: string;
      /** Where it actually landed, when the channel can report it. */
      readonly target?: DeliveryTarget;
      /**
       * Every conversation that received it.
       *
       * Delivery fans out to all subscriptions, so "sent" is not one destination. The
       * single `target` stays as the common case (one recipient); the UI prefers this
       * list when present.
       */
      readonly targets?: readonly DeliveryTarget[];
    }
  | {
      readonly ok: false;
      /** Stable machine-readable code; the UI picks its copy from this. */
      readonly code:
        | "unreachable"
        | "unauthorized"
        | "rejected"
        | "timeout"
        | "write-failed"
        | "unknown";
      readonly message: string;
    };

/**
 * Inbox payload: the complete content sent on delivery.
 *
 * Carries both the rendered `prompt` and the structured `bundle`. That looks
 * redundant, but the two serve different readers: the plugin injects `prompt`
 * verbatim (that is what the user sees), while `bundle` lets it do other things
 * later (archiving, cards, locating by annotation) without re-parsing text.
 */
export interface InboxPayload {
  readonly schemaVersion: 1;
  /**
   * Explicit target session id (`ses_...`). Missing means "let the plugin pick".
   *
   * Why this exists: OpenCode can have several windows open while the plugin
   * runs in **one** server process, which cannot see which window is focused.
   * With multiple sessions in the same project directory the plugin has to
   * guess, and guessing wrong drops the annotation into another conversation.
   * Letting the user pin a session hands that uncertainty back to the person who
   * knows the answer.
   */
  readonly targetSessionID?: string;
  /**
   * Which app instance asked for this delivery.
   *
   * Queued records carry it so a replay after a restart is delivered to the subscribers of
   * the app they came from, rather than to whoever happens to be subscribed later. Absent
   * in older records, in which case the project directory is the only clue.
   */
  readonly appId?: string;
  readonly prompt: string;
  readonly bundle: AnnotationBundle;
}

/**
 * The prompt delivery channel.
 *
 * This is the only seam between this project and OpenCode. There are three
 * implementations:
 * - direct HTTP to the plugin's inbox (production)
 * - a file outbox (nothing is lost while the plugin is down; it drains later)
 * - mock (tests)
 *
 * It is an interface because the injection mechanism changes with OpenCode
 * versions; switching how prompts are injected must not touch the UI or the
 * annotation logic.
 */
export interface PromptSink {
  /** Stable name for logs and UI. */
  readonly name: string;
  deliver(
    bundle: AnnotationBundle,
    prompt: string,
    options?: DeliverOptions,
  ): Promise<DeliveryOutcome>;
}

/** Minimal pre-flight validation so a half-built bundle never leaves the app. */
export function validateBundle(bundle: AnnotationBundle): string | null {
  if (bundle.schemaVersion !== 1) return `Unsupported protocol version: ${String(bundle.schemaVersion)}`;
  if (!bundle.projectDir.trim()) return "Missing project directory";
  if (!bundle.projectId.trim()) return "Missing project id";
  /*
   * An empty payload is refused, but **handwriting counts as content**.
   *
   * Ink has no block reference, so a frame the user only wrote on produces no
   * annotation — yet it carries the real message: the picture with their strokes. The
   * old check counted blocks only, so exactly that case was rejected as "nothing to
   * send" while the user was looking at their handwriting on screen.
   */
  if (bundle.annotations.length === 0 && (bundle.ink ?? []).length === 0) {
    return "No annotations to deliver";
  }
  for (const annotation of bundle.annotations) {
    if (!annotation.frame.compositionPath.trim()) {
      return `Annotation ${annotation.id} has no composition path`;
    }
    if (!Number.isFinite(annotation.frame.time) || annotation.frame.time < 0) {
      return `Annotation ${annotation.id} has an invalid timecode`;
    }
  }
  for (const capture of bundle.ink ?? []) {
    if (!capture.imagePath.trim()) return "A handwriting capture has no image path";
    /*
     * A board sketch has no playhead. Its time exists only to identify the frame the board
     * replaced, so requiring it to be valid would reject a perfectly good sketch — and the
     * reader is told outright that there is no timecode to look at (found.md F-128).
     */
    if (capture.board) continue;
    if (!Number.isFinite(capture.time) || capture.time < 0) {
      return "A handwriting capture has an invalid timecode";
    }
  }
  for (const element of bundle.elements ?? []) {
    /*
     * An element states its frame, so the frame has to be usable.
     *
     * Its picture is a picture of one specific frame; a payload naming a composition that cannot
     * be resolved hands the reader evidence it cannot reproduce. Absent `frame` is tolerated on
     * purpose: a payload produced before the field existed is still readable, and rejecting it
     * would break records already sitting in an outbox (found.md F-129).
     */
    if (element.frame === undefined) continue;
    if (!element.frame.compositionPath.trim()) {
      return `Element ${element.ref ?? ""} has no composition path`;
    }
    if (!Number.isFinite(element.frame.time) || element.frame.time < 0) {
      return `Element ${element.ref ?? ""} has an invalid timecode`;
    }
  }
  return null;
}
