/**
 * Eraser behaviour, in one place.
 *
 * Two numbers matter and both are shared between the toolbar and the canvas:
 *
 * - `ERASER_RADIUS_PX` — how close the pointer must be to a mark. In **pixels**,
 *   converted to normalized units through the stage, so the eraser feels the same at
 *   any zoom or window size.
 * - `ERASE_HOLD_MS` — how long the eraser button must be pressed before it clears
 *   **every** mark at **every** timecode. Deliberately long enough that a normal click
 *   can never trip it: erasing one mark is routine, wiping the project is not.
 *
 * Kept out of the components because the two must agree: a toolbar that waits longer
 * than the canvas expects would feel randomly unresponsive.
 */

/** Pointer-to-mark hit radius, in screen pixels. */
export const ERASER_RADIUS_PX = 10;

/** Press-and-hold duration before the eraser clears every mark. */
export const ERASE_HOLD_MS = 650;
