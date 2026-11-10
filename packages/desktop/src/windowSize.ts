/**
 * Window geometry, kept separate from `main.ts` so it can be tested without Electron.
 *
 * The numbers are a **product decision**, not an arbitrary guard: this app is meant to sit
 * beside other windows on one screen. The previous minimum (1100 × 720) was larger than
 * half of a 1920 × 1080 display, so the window could never be parked next to anything —
 * tiling compositors pinned it to that size and the user had no way down.
 *
 * The rule that replaces it: **the window must be shrinkable to half of a common laptop
 * screen** (1920 × 1080 → 960 × 540) with room to spare. The layout handles the rest by
 * lowering its own floors on narrow windows (see `dockLayout.ts`).
 */

/** Preferred size when the compositor lets the app choose. */
export const DEFAULT_WINDOW_WIDTH = 1680;
export const DEFAULT_WINDOW_HEIGHT = 1020;

/**
 * Smallest size the user may shrink the window to.
 *
 * Chosen so that:
 * - 420 is well under half of 1920 (960) — the window fits beside a browser or an editor;
 * - three columns still have somewhere to go: the preview keeps a 220px floor at that width
 *   and the two side columns take 100 each, which is `dockview`'s own hard minimum per
 *   group (see `layoutFloors` in `dockLayout.ts`);
 * - a video preview plus a timeline remain legible, which is the point of the window.
 */
export const MIN_WINDOW_WIDTH = 420;
export const MIN_WINDOW_HEIGHT = 340;
