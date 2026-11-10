import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "./windowSize.js";

/**
 * The window's minimum size.
 *
 * This is a product promise, not a technical limit: the app shares a screen with a
 * browser and an editor, so it has to be parkable beside them. The previous floor
 * (1100 × 720) was more than half of a 1920 × 1080 display, and a tiling compositor
 * honoured it — the window simply could not get smaller, which is what the user hit.
 *
 * These tests pin the promise so a future layout tweak cannot silently take it back.
 */

/** A common laptop panel; the reference the floor is chosen against. */
const REFERENCE = { width: 1920, height: 1080 };

describe("window minimum size", () => {
  it("fits in half a common screen, with room to spare", () => {
    // Halves, not thirds: two of these windows must fit side by side on one display.
    expect(MIN_WINDOW_WIDTH).toBeLessThanOrEqual(REFERENCE.width / 2);
    expect(MIN_WINDOW_HEIGHT).toBeLessThanOrEqual(REFERENCE.height / 2);
  });

  it("is far below the size that used to be the floor", () => {
    /*
     * The regression, in one assertion: 1100 × 720 could not be halved on a 1920-wide
     * screen, and tiling compositors enforce whatever the app asks for.
     */
    expect(MIN_WINDOW_WIDTH).toBeLessThan(1100);
    expect(MIN_WINDOW_HEIGHT).toBeLessThan(720);
  });

  it("still leaves a usable app", () => {
    // A floor of 200px would technically satisfy the rule above and be useless.
    expect(MIN_WINDOW_WIDTH).toBeGreaterThanOrEqual(360);
    expect(MIN_WINDOW_HEIGHT).toBeGreaterThanOrEqual(300);
  });

  it("opens larger than its minimum, so the floor is an override and not the default", () => {
    expect(DEFAULT_WINDOW_WIDTH).toBeGreaterThan(MIN_WINDOW_WIDTH);
    expect(DEFAULT_WINDOW_HEIGHT).toBeGreaterThan(MIN_WINDOW_HEIGHT);
  });
});
