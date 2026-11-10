/**
 * Read the host config injected by the desktop app.
 *
 * Studio needs to know the project id, project directory, preview origin and
 * plugin endpoint in order to capture frames and deliver prompts. The desktop app
 * provides them over the bridge, and the frontend fetches them once and caches.
 *
 * Running in a plain browser (no desktop host) makes that request 404 — that is
 * not an error, it is the normal degraded mode ("annotation unavailable"), and the
 * UI explains it.
 */

import type { HostConfig } from "@mystudio/protocol";
import { BRIDGE_ROUTES } from "@mystudio/protocol";

export type HostConfigResult =
  | { readonly kind: "ready"; readonly config: HostConfig }
  | { readonly kind: "unavailable"; readonly reason: string };

let cached: Promise<HostConfigResult> | null = null;

/** Fetch the config (cached per process). `force` is for reconnect scenarios. */
export function loadHostConfig(force = false): Promise<HostConfigResult> {
  if (!cached || force) cached = fetchHostConfig();
  return cached;
}

async function fetchHostConfig(): Promise<HostConfigResult> {
  let response: Response;
  try {
    response = await fetch(BRIDGE_ROUTES.config, { headers: { accept: "application/json" } });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Cannot read the host config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      kind: "unavailable",
      reason:
        response.status === 404
          ? "Not running inside the MyStudio desktop app; annotations and delivery are unavailable."
          : `Host config returned HTTP ${response.status}`,
    };
  }

  const parsed: unknown = await response.json().catch(() => null);
  if (!isHostConfig(parsed)) {
    return { kind: "unavailable", reason: "Host config is malformed" };
  }
  return { kind: "ready", config: parsed };
}

function isHostConfig(value: unknown): value is HostConfig {
  if (typeof value !== "object" || value === null) return false;
  return (
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "projectId" in value &&
    typeof value.projectId === "string" &&
    "projectDir" in value &&
    typeof value.projectDir === "string" &&
    "previewOrigin" in value &&
    typeof value.previewOrigin === "string" &&
    "inboxEndpoint" in value &&
    typeof value.inboxEndpoint === "string"
  );
}

/** Reset the cache; for tests. */
export function resetHostConfigCache(): void {
  cached = null;
}
