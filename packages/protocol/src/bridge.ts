/**
 * Host bridge contract.
 *
 * The Studio fork runs in a browser environment (Electron's BrowserWindow): it
 * cannot write to disk or start an HTTP server. Saving a captured frame and
 * delivering a prompt therefore have to go through the main process.
 *
 * This file defines the request/response shapes shared by both sides:
 * studio-shell sends, desktop receives. It is a contract that neither side may
 * change unilaterally, so it lives in the protocol package next to the delivery
 * interface.
 *
 * It does **not** depend on Node — both the desktop process and the browser
 * import these types.
 */

import type { DeliveryOutcome, InboxPayload } from "./sink.js";

/** Runtime config the host injects into the frontend; fetched once at startup. */
export interface HostConfig {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectDir: string;
  /** OpenCode plugin inbox endpoint; empty means "file outbox only". */
  readonly inboxEndpoint: string;
  /** Local Hyperframes preview origin (Studio's API lives under it). */
  readonly previewOrigin: string;
}

/** Capture a rectangle of the rendered window, in CSS pixels relative to the viewport. */
export interface ScreenCaptureRequest {
  readonly schemaVersion: 1;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type ScreenCaptureResponse =
  | { readonly ok: true; readonly pngBase64: string }
  | { readonly ok: false; readonly error: string };

/** Save one captured frame. The image travels as base64 to avoid a multipart dependency. */
export interface SaveFrameRequest {
  readonly schemaVersion: 1;
  readonly annotationId: string;
  /** PNG as base64 (without a data URL prefix). */
  readonly pngBase64: string;
}

/**
 * Result of saving a capture.
 *
 * A discriminated union rather than an `ok` flag with optional fields: the caller
 * needs `path` exactly when saving succeeded, and this shape makes that impossible
 * to forget.
 */
export type SaveFrameResponse =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** The deliver request body has the same shape as the inbox payload. */
export type DeliverRequest = InboxPayload;

export interface DeliverResponse {
  readonly outcome: DeliveryOutcome;
  /** Name of the sink actually used, e.g. `http+file-outbox`; null when unconfigured. */
  readonly sink: string | null;
}

/** Fixed prefix for bridge endpoints, shared by both sides so it cannot drift. */
export const BRIDGE_PREFIX = "/__mystudio";

export const BRIDGE_ROUTES = {
  config: `${BRIDGE_PREFIX}/config`,
  frame: `${BRIDGE_PREFIX}/frame`,
  /**
   * Capture a rectangle of the **rendered window**.
   *
   * This is the "one picture" path: the browser has already composited the frame, the ink, the
   * arrows, the boxes and the badges, so reading that surface cannot disagree with what the user
   * sees. Drawing the marks onto a clean frame was a **second renderer** of the same thing, and a
   * second renderer always drifts — the delivered image showed marks the screen did not
   * (found.md F-122).
   */
  screen: `${BRIDGE_PREFIX}/screen`,
  deliver: `${BRIDGE_PREFIX}/deliver`,
  /** Quit the app: a frameless window on a tiling desktop has no system close button. */
  quit: `${BRIDGE_PREFIX}/quit`,
  /**
   * Ask the host to open another project.
   *
   * A browser page cannot open a native directory picker, so this has to go through the
   * main process. The response is deliberately minimal — "did a project open" — because
   * the window reloads into the new project; there is nothing for the caller to do with
   * the path afterwards.
   */
  openProject: `${BRIDGE_PREFIX}/open-project`,
  /**
   * Conversations subscribed to **this app**.
   *
   * Read-only: subscriptions are created from inside OpenCode (the agent runs a tool), not
   * from here. The app lists them so the user can see who will receive each annotation —
   * "sent" with no destination cannot be checked.
   */
  subscribers: `${BRIDGE_PREFIX}/subscribers`,
} as const;

/** One conversation subscribed to this app. */
export interface SubscriberSummary {
  readonly sessionID: string;
  /** Title the plugin reported, when it had one. */
  readonly title?: string;
  readonly createdAt: number;
}

export type SubscribersResponse =
  | { readonly ok: true; readonly subscribers: readonly SubscriberSummary[] }
  | { readonly ok: false; readonly error: string };

export interface OpenProjectResponse {
  readonly ok: boolean;
  /** Why it did not open; present only when `ok` is false. */
  readonly error?: string;
  /** Whether the user cancelled the picker, as opposed to an error. */
  readonly cancelled?: boolean;
}
