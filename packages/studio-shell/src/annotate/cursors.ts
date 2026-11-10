/**
 * What the pointer looks like on each surface.
 *
 * ## The bug this replaces
 *
 * Every tool showed a crosshair, everywhere. Two causes, and only one of them was the
 * canvas:
 *
 * 1. The canvas returned `crosshair` for every drawing tool, so a pen, an arrow and a
 *    region box were indistinguishable until something was drawn.
 * 2. The **input shield** — the transparent full-viewport layer that keeps presses away
 *    from Studio while this layer is active — also declared `crosshair`. That layer covers
 *    the whole window, so the cursor was a crosshair over the empty margins, over panel
 *    gaps, over everything. The canvas's own choice rarely had a chance to show.
 *
 * ## What a cursor is for
 *
 * It is the only feedback before the first stroke: it says which gesture the next press
 * will start. A crosshair means "I will draw a line or a box"; a pen means "I will write";
 * an arrow means "I will point from A to B"; a circle means "I will erase what is inside".
 * Using one symbol for four gestures throws that away.
 *
 * Cursors are inline SVG data URLs rather than images so this stays a single file with no
 * asset pipeline, and so the hotspot can be placed exactly on the nib or the circle centre.
 */

import type { AnnotationTool } from "./editorState.js";

/**
 * A pen nib with its **tip** at the hotspot.
 *
 * The hotspot is where the drawn point appears, so it must be the nib, not the centre of
 * the icon — otherwise every stroke lands a few pixels away from where the user aimed.
 */
const PEN_CURSOR =
  "url(\"data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <path d="M2 18 L3.5 13 L13 3.5 A2.1 2.1 0 0 1 16.5 7 L7 16.5 Z"
            fill="#101114" stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round"/>
      <path d="M12 4.5 L15.5 8" stroke="#ffffff" stroke-width="0.9"/>
    </svg>`,
  ) +
  "\") 2 18, crosshair";

/**
 * An arrow pointing up-and-right, hotspot at the tail.
 *
 * The tail is where the press starts, which is the element the arrow is drawn from.
 */
const ARROW_CURSOR =
  "url(\"data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <path d="M2 18 L17 3" stroke="#101114" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M17 3 L10 4.2 M17 3 L15.8 10" stroke="#101114" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M2 18 L17 3" stroke="#ffffff" stroke-width="0.7" stroke-linecap="round"/>
    </svg>`,
  ) +
  "\") 2 18, crosshair";

/**
 * An eraser ring whose hotspot is its **centre**.
 *
 * The eraser is a hit test with a tolerance around the pointer, so a ring centred on the
 * hotspot is an honest picture of what it will take. A crosshair would show where the
 * pointer is and say nothing about the reach.
 */
const ERASER_CURSOR =
  "url(\"data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="8" fill="none" stroke="#101114" stroke-width="2.2"/>
      <circle cx="11" cy="11" r="8" fill="none" stroke="#ffffff" stroke-width="1"/>
    </svg>`,
  ) +
  "\") 11 11, cell";

/**
 * The cursor for a tool.
 *
 * `select` is deliberately the platform default: it draws nothing, so it should look like
 * nothing is armed. The canvas also stops receiving pointers in that mode (`pointerEvents:
 * none`), which is what lets Studio be clicked through.
 */
export function cursorForTool(tool: AnnotationTool): string {
  switch (tool) {
    case "select":
      return "default";
    case "region":
      return "crosshair";
    case "arrow":
      return ARROW_CURSOR;
    case "freehand":
      return PEN_CURSOR;
    case "eraser":
      return ERASER_CURSOR;
  }
}

/**
 * The cursor for the input shield.
 *
 * **Not** a crosshair: the shield covers the entire window, so whatever it declares is the
 * cursor over every gap and margin. A crosshair there claimed every empty pixel was
 * drawable, which was both wrong and the reason the per-tool cursors were never seen.
 *
 * `default` while a drawing tool is armed — the pointer stays the platform arrow over
 * non-drawable area, so the crosshair (or pen) only appears where drawing actually happens.
 */
export function cursorForShield(): string {
  return "default";
}
