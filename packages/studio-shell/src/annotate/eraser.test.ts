import { describe, expect, it } from "vitest";
import { ERASE_HOLD_MS, ERASER_RADIUS_PX } from "./eraser.js";

/**
 * The eraser's two numbers.
 *
 * These are pinned because both the toolbar and the canvas depend on them, and a
 * value chosen carelessly turns a routine action into an accident:
 * - the hit radius must be big enough to hit a 2.5px line without precision aiming,
 *   and small enough that clicking beside a mark does not erase it;
 * - the hold must be far longer than a click, or clicking the eraser would wipe a
 *   whole timecode.
 */

describe("eraser tuning", () => {
  it("has a hit radius a person can aim at, but not so wide it grabs neighbours", () => {
    expect(ERASER_RADIUS_PX).toBeGreaterThanOrEqual(6);
    expect(ERASER_RADIUS_PX).toBeLessThanOrEqual(24);
  });

  it("requires a hold far longer than any click", () => {
    // A double-click is ~300ms; anything below that would be reachable by accident.
    expect(ERASE_HOLD_MS).toBeGreaterThan(400);
    // And short enough that the gesture is not a chore.
    expect(ERASE_HOLD_MS).toBeLessThan(1500);
  });
});
