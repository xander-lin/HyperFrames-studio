/**
 * Interface zoom — for **two separate interfaces**.
 *
 * ## Why they are separate
 *
 * `Ctrl` `+` / `-` / `0` used to resize both at once: Studio's rem-based UI *and* (after a
 * later fix) this overlay. That is wrong in both directions. Studio's editor and this
 * annotation layer are different surfaces with different needs: a user who zooms in to read
 * the timeline does not want the drawing toolbar to grow over the picture as well, and a
 * user who enlarges the toolbar because they cannot hit it does not want the whole editor
 * to reflow underneath.
 *
 * So each has its own ladder and its own stored value, and **one chord** goes to whichever
 * surface currently owns the input:
 *
 * - annotating → this layer's chrome scales; Studio stays put.
 * - not annotating → Studio scales; this layer stays put.
 *
 * That mirrors the rest of the interaction model (`A` decides who receives input), so the
 * zoom chord behaves like every other input: it goes to whoever has the keyboard.
 *
 * ## What is never scaled
 *
 * The drawing canvas. Annotation coordinates are normalised against the video's own pixels
 * (`geometry.ts`), so scaling them would move every mark already on the frame.
 *
 * ## Why the layer scales with `transform` and not a root font size
 *
 * Every control here is sized in pixels, deliberately, so it stays legible over arbitrary
 * footage. Pixels do not follow `font-size`; a transform does.
 */

/** Discrete steps rather than continuous values, to avoid a vague "always blurry" feel. */
const STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
type Step = (typeof STEPS)[number];

/** Studio's scale: applied as a root font size, so every `rem` in the editor follows. */
const STUDIO_KEY = "mystudio:ui-scale";
/** This layer's scale: applied as a transform on the overlay container. */
const LAYER_KEY = "mystudio:layer-scale";

/** Which surface a zoom action applies to. */
export type ZoomTarget = "studio" | "layer";

let studioScale = 1;
let layerScale = 1;

const studioListeners = new Set<() => void>();
const layerListeners = new Set<() => void>();

function announce(scale: number): void {
  layerScale = scale;
  for (const listener of layerListeners) listener();
}

/** The layer's scale in force right now. */
export function uiScale(): number {
  return layerScale;
}

/** Studio's scale in force right now. */
export function studioUiScale(): number {
  return studioScale;
}

/** Subscribe to this layer's scale changes; returns the unsubscribe function. */
export function subscribeUiScale(listener: () => void): () => void {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
}

/** Subscribe to Studio's scale changes. */
export function subscribeStudioScale(listener: () => void): () => void {
  studioListeners.add(listener);
  return () => studioListeners.delete(listener);
}

/**
 * The space this layer has to lay itself out in, **in its own coordinates**.
 *
 * The overlay is rendered inside a container scaled with `transform: scale()`. A child's
 * `position: fixed` is then relative to that container, and its pixel values are in
 * *unscaled* units — so the usable width is the window's width divided by the scale. Using
 * `window.innerWidth` directly would let a tool at 150% believe it has 1.5× the room it
 * really has, and drape itself off the edge.
 */
export function layoutViewport(): { readonly width: number; readonly height: number } {
  const scale = layerScale > 0 ? layerScale : 1;
  const width = typeof window === "undefined" ? 1280 : window.innerWidth / scale;
  const height = typeof window === "undefined" ? 720 : window.innerHeight / scale;
  return { width, height };
}

/** Read a stored scale, snapping junk to 1 and unknown numbers to the nearest step. */
function readStored(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return STEPS[indexOf(parsed)]!;
  } catch {
    // Storage unavailable: use the default.
  }
  return 1;
}

function writeStored(key: string, scale: number): void {
  try {
    window.localStorage.setItem(key, String(scale));
  } catch {
    // Ignore: it still applies this session, it just will not be remembered.
  }
}

/**
 * Apply Studio's scale.
 *
 * Root font size and `--ui-scale` only. This is Studio's own convention, so its components
 * keep working untouched.
 */
export function applyStudioScale(scale: number): void {
  const root = document.documentElement;
  // 16px is the Tailwind / Studio base; scaling it makes every rem follow.
  root.style.fontSize = `${16 * scale}px`;
  root.style.setProperty("--ui-scale", String(scale));
  studioScale = scale;
  writeStored(STUDIO_KEY, scale);
  for (const listener of studioListeners) listener();
}

/**
 * Apply this layer's scale.
 *
 * Notifies the overlay, which re-renders its transform. Nothing about Studio changes.
 */
export function applyLayerScale(scale: number): void {
  writeStored(LAYER_KEY, scale);
  announce(scale);
}

/**
 * Apply a scale to one surface.
 *
 * Kept because callers that know which surface they mean should say so explicitly; the
 * chord uses `zoomTargetFor` instead.
 */
export function applyUiScale(scale: number, target: ZoomTarget = "studio"): void {
  if (target === "studio") applyStudioScale(scale);
  else applyLayerScale(scale);
}

/** Index of the current step in STEPS; nearest match when absent. */
function indexOf(scale: number): number {
  const exact = STEPS.indexOf(scale as Step);
  if (exact !== -1) return exact;
  let best = 0;
  for (let i = 0; i < STEPS.length; i += 1) {
    if (Math.abs(STEPS[i]! - scale) < Math.abs(STEPS[best]! - scale)) best = i;
  }
  return best;
}

/** Read the scale in force for a target. */
export function readUiScale(target: ZoomTarget = "studio"): number {
  return target === "studio" ? studioScale : layerScale;
}

/** Zoom in one step on a target; returns the new value. */
export function zoomIn(target: ZoomTarget = "studio", current = readUiScale(target)): number {
  const next = STEPS[Math.min(STEPS.length - 1, indexOf(current) + 1)]!;
  applyUiScale(next, target);
  return next;
}

/** Zoom out one step on a target. */
export function zoomOut(target: ZoomTarget = "studio", current = readUiScale(target)): number {
  const next = STEPS[Math.max(0, indexOf(current) - 1)]!;
  applyUiScale(next, target);
  return next;
}

/** Reset a target to 100%. */
export function zoomReset(target: ZoomTarget = "studio"): number {
  applyUiScale(1, target);
  return 1;
}

/**
 * Which surface the zoom chord should resize **right now**.
 *
 * One rule, in one place: whoever is receiving input gets the zoom. The annotation layer
 * takes over the keyboard while active, so it takes the chord with it; otherwise Studio is
 * the thing the user is working in and the chord is its own.
 */
export function zoomTargetFor(annotating: boolean): ZoomTarget {
  return annotating ? "layer" : "studio";
}

/**
 * Handle a zoom key. Returns true when the event was consumed.
 *
 * Recognised combinations: `Ctrl/Cmd + =`, `Ctrl/Cmd + -`, `Ctrl/Cmd + 0`.
 * `=` and `-` have different codes on different layouts, so both `key` and `code`
 * are checked.
 */
export function handleZoomKey(
  event: KeyboardEvent,
  target: ZoomTarget = "studio",
): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;

  const key = event.key;
  const code = event.code;

  if (key === "=" || key === "+" || code === "Equal" || code === "NumpadAdd") {
    event.preventDefault();
    zoomIn(target);
    return true;
  }
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") {
    event.preventDefault();
    zoomOut(target);
    return true;
  }
  if (key === "0" || code === "Digit0" || code === "Numpad0") {
    event.preventDefault();
    zoomReset(target);
    return true;
  }
  return false;
}

/** Restore both stored scales at startup. */
export function restoreUiScale(): void {
  applyStudioScale(readStored(STUDIO_KEY));
  applyLayerScale(readStored(LAYER_KEY));
}
