/**
 * Asking the host to open a different project.
 *
 * A browser page cannot show a native directory picker, so this goes through the bridge
 * and the main process does the choosing. It lives in its own module because **two** call
 * sites need it — the sprite's "Open project…" row and the mount point that passes the
 * handler down — and two copies of the same `fetch` is how one of them quietly stops
 * matching the route.
 *
 * On success the window reloads into the new project, so there is nothing to do here.
 * Failure is the main process's to report: it owns the dialog that explains a picker or
 * a project that would not open.
 */

import { BRIDGE_ROUTES } from "@mystudio/protocol";

export async function requestOpenProject(): Promise<void> {
  try {
    await fetch(BRIDGE_ROUTES.openProject, { method: "POST" });
  } catch {
    // Host unreachable. The sprite is not the place to explain a transport error, and
    // the main process shows its own dialog when the picker itself fails.
  }
}
