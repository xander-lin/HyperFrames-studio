/**
 * Stacking order for the annotation layers.
 *
 * **Why centralised:** dockview hard-codes `z-index: 99` on its splitter
 * `.dv-sash` (upstream CSS, not configurable). Our layers used scattered numbers
 * like 35 / 40 / 60 / 71 — all below it — so the toolbar was **visible but
 * unclickable**: drawn on top, yet the pointer was intercepted by the sash. The
 * symptom was "it simply will not drag" (found.md F-033).
 *
 * Hence one hard rule: **every annotation layer must sit above `dv-sash`**, and
 * leave clearly readable gaps between each other.
 *
 * Constants rather than raw numbers in components, so a future adjustment happens
 * in one place and nobody reintroduces a stray `72` and falls in the same hole.
 */

/** dockview's sash level (upstream fixed value, for comparison only — do not reuse). */
export const DOCKVIEW_SASH_Z_INDEX = 99;

/** Stacking order. Higher is closer to the viewer. */
export const ANNOTATION_LAYERS = {
  /**
   * Input shield: blocks every pointer event from reaching Studio underneath.
   *
   * Must be **below** the annotation canvas — otherwise pointers meant for the
   * canvas are eaten by the shield and nothing can be drawn.
   */
  shield: 100,
  /** Annotation canvas. Above the shield so it receives drawing gestures. */
  canvas: 105,
  /** The annotation window container itself (not its content). */
  surface: 110,
  /** Toolbar: draggable and clickable, so it must clear the sash. */
  dock: 115,
  /** Draft bubble: sits next to the stroke and must accept typing. */
  draft: 120,
  /** Prompt panel and property float. */
  panel: 125,
  /** Screen sprite: always docked to an edge and always clickable. */
  sprite: 130,
} as const;

/** For tests: every layer must clear the sash. */
export function allLayersAboveSash(): boolean {
  return Object.values(ANNOTATION_LAYERS).every((z) => z > DOCKVIEW_SASH_Z_INDEX);
}
