/**
 * Geometry: canvas ↔ normalized coordinates, and element picking inside the
 * preview iframe.
 *
 * This is where all annotation precision comes from, so it is deliberately
 * React-free: pure functions plus one DOM query.
 *
 * Three coordinate spaces must be kept apart:
 * 1. **client**: mouse `clientX/clientY`, relative to the browser window.
 * 2. **stage**: the preview stage (the rect where the composition actually
 *    renders), determined by the outer container.
 * 3. **composition**: the composition's own design space (e.g. 1920×1080), inside
 *    the iframe.
 *
 * Annotations store normalized coordinates (0..1, relative to the stage), which
 * decouples them from all three.
 */

import type { ElementRef, Point, Rect } from "@mystudio/protocol";

/** Normalized point → pixel offset inside the stage. */
export function toStagePixels(point: Point, stage: { width: number; height: number }): Point {
  return { x: point.x * stage.width, y: point.y * stage.height };
}

/** Pixel offset inside the stage → normalized point. Clamped to 0..1. */
export function toNormalized(
  point: Point,
  stage: { width: number; height: number },
): Point {
  if (stage.width <= 0 || stage.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01(point.x / stage.width),
    y: clamp01(point.y / stage.height),
  };
}

/** Convert client coordinates into normalized stage coordinates. */
export function clientToNormalized(
  client: { clientX: number; clientY: number },
  stageRect: { left: number; top: number; width: number; height: number },
): Point {
  return toNormalized(
    { x: client.clientX - stageRect.left, y: client.clientY - stageRect.top },
    { width: stageRect.width, height: stageRect.height },
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Pick the element at a normalized point inside the iframe.
 *
 * Why it is needed: a region is not bound to an element, but **an arrow** has to
 * know what it was drawn from, and summaries often want to name the element.
 * Making the user also click it in the layers panel is friction — asking at the
 * arrow's tail is the natural place.
 *
 * Failure is normal (empty background, iframe not loaded, cross-origin); return
 * null rather than throwing.
 */
export function pickElementAt(
  doc: Document | null,
  point: Point,
): Element | null {
  if (!doc) return null;
  const view = doc.defaultView;
  if (!view) return null;

  // Normalized → iframe viewport coordinates, falling back to visualViewport so a
  // zoomed browser does not compute the point outside the canvas.
  const viewport = view.visualViewport;
  const width = viewport?.width ?? view.innerWidth;
  const height = viewport?.height ?? view.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const target = doc.elementFromPoint(point.x * width, point.y * height);
  if (!target) return null;

  // The hit may be an annotation/overlay node that must not be named; walk up to
  // the first meaningful element.
  return firstMeaningfulElement(target);
}

/**
 * Walk up from the hit node to something the user can actually see.
 *
 * Rules: skip html/body, and skip Studio-injected overlay nodes
 * (`data-hf-overlay`). Our own layers are marked `data-mystudio` and skipped too.
 */
function firstMeaningfulElement(start: Element): Element | null {
  let node: Element | null = start;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html") return null;
    if (tag === "body") return node;
    if (node.hasAttribute("data-mystudio-overlay")) {
      node = node.parentElement;
      continue;
    }
    return node;
  }
  return null;
}

/**
 * Describe an element as a durable reference.
 *
 * Priority: `data-hf-id` (Hyperframes' stable id, survives reflow) → `id` → a CSS
 * selector. The bounding box and text are recorded too, so a receiver can tell
 * what this is even without the DOM.
 */
export function describeElement(
  element: Element,
  stageRect: { width: number; height: number },
): ElementRef {
  const box = element.getBoundingClientRect();
  const ref: {
    -readonly [K in keyof ElementRef]: ElementRef[K];
  } = {
    tagName: element.tagName.toLowerCase(),
  };

  const hfId = element.getAttribute("data-hf-id");
  if (hfId) ref.hfId = hfId;

  const id = element.getAttribute("id");
  if (id) ref.id = id;

  const selector = buildSelector(element);
  if (selector) ref.selector = selector;

  if (stageRect.width > 0 && stageRect.height > 0) {
    ref.box = normalizeRect(box, stageRect);
  }

  const text = element.textContent?.trim();
  if (text) ref.text = text;

  return ref;
}

function normalizeRect(
  box: { left: number; top: number; width: number; height: number },
  stage: { width: number; height: number },
): Rect {
  return {
    x: clamp01(box.left / stage.width),
    y: clamp01(box.top / stage.height),
    width: clamp01(box.width / stage.width),
    height: clamp01(box.height / stage.height),
  };
}

/**
 * Build a selector unique enough for our purpose.
 *
 * `#id` first; otherwise "tag + a couple of key classes" (two at most — more
 * becomes a brittle auto-generated soup). Last resort is the bare tag name so this
 * never returns empty.
 */
function buildSelector(element: Element): string {
  const id = element.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;

  const tag = element.tagName.toLowerCase();
  const classes = Array.from(element.classList)
    .filter((name) => /^[A-Za-z_][\w-]*$/.test(name))
    .slice(0, 2);
  if (classes.length > 0) return `${tag}.${classes.map(cssEscape).join(".")}`;
  return tag;
}

/** Fallback for CSS.escape, which the iframe may lack (old engines, test envs). */
function cssEscape(value: string): string {
  const withEscape = globalThis.CSS as { escape?: (v: string) => string } | undefined;
  if (typeof withEscape?.escape === "function") return withEscape.escape(value);
  return value.replace(/([^\w-])/g, "\\$1");
}
