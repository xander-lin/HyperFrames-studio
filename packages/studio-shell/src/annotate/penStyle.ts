/**
 * What a pen is, and the values it can take.
 *
 * Kept apart from the controls on purpose: the stores (`boardStore`, the annotation pen)
 * need the type and the defaults, and must not pull in a React component just to name a
 * colour. Importing UI to describe data is how a store ends up depending on the toolbar.
 */

/** Colour and weight of a stroke. */
export interface PenStyle {
  /** `#rrggbb`. */
  readonly colour: string;
  /** Base width in CSS pixels at scale 1. */
  readonly width: number;
}

/**
 * Colours that stay distinguishable on any background.
 *
 * Red first, because "correct this" is the common case and the default should need no
 * decision. The rest are spaced around the hue circle so two adjacent choices are never
 * confusable at a glance, and each is saturated enough to read over white slides and dark
 * footage alike.
 */
export const PEN_COLOURS: readonly { readonly value: string; readonly name: string }[] = [
  { value: "#ff3b30", name: "Red" },
  { value: "#f5a524", name: "Amber" },
  { value: "#37b878", name: "Green" },
  { value: "#3b9dff", name: "Blue" },
  { value: "#ffffff", name: "White" },
  { value: "#101114", name: "Black" },
];

/**
 * Weights, in CSS pixels.
 *
 * Seven steps rather than three: a pen has to suit both "sign here" and "circle this whole
 * panel", and three sizes forced a choice between a hairline and a marker. Each is still a
 * discrete step — a slider asks the user to aim at a number they cannot see, while stepping
 * asks "thicker or thinner".
 */
export const PEN_WIDTHS: readonly { readonly value: number; readonly name: string }[] = [
  { value: 1.2, name: "Hairline" },
  { value: 1.8, name: "Thin" },
  { value: 2.4, name: "Light" },
  { value: 3, name: "Regular" },
  { value: 4.2, name: "Medium" },
  { value: 5.5, name: "Bold" },
  { value: 7, name: "Heavy" },
];

/** Index of the nearest weight step, so a stored custom width still shows a position. */
export function penWidthIndex(width: number): number {
  let best = 0;
  for (let index = 0; index < PEN_WIDTHS.length; index += 1) {
    if (
      Math.abs(PEN_WIDTHS[index]!.value - width) < Math.abs(PEN_WIDTHS[best]!.value - width)
    ) {
      best = index;
    }
  }
  return best;
}

/** What the video starts with: high-contrast red, because footage is unpredictable. */
export const DEFAULT_PEN: PenStyle = { colour: "#ff3b30", width: 3 };

/** Board paper: near-white, slightly warm, so black ink reads as ink and not as a hole. */
export const BOARD_PAPER = "#f6f4ef";
