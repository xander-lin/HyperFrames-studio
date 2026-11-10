/**
 * When a snapshot needs to be regenerated: **only when something actually changed**.
 *
 * ## The rule the user stated
 *
 * > 截图是最终状态呀… 连按两次 `Ctrl+S` 只有一个截图。我再画一条线…会有一张新的截图。
 * > 关键是看有没有新的动作。选中一个元素也算是新的动作。但是选中同一个元素，那就不算
 * > 动作更新。
 *
 * So a snapshot is not "a picture taken per keystroke", it is "the current state, captured
 * when the state moved". Pressing add-to-prompt twice in a row must not produce two identical
 * pictures — the second press adds nothing the reader can use.
 *
 * ## Why the comparison is over a signature rather than a boolean flag
 *
 * "Did anything change since the last capture?" has to survive undo, erase and clear: after
 * undoing a stroke the picture must be regenerated too, because the old one still shows the
 * stroke. A flag would have to be cleared by every one of those operations, and one forgotten
 * call site leaves a stale picture. A signature is derived from the current state, so it is
 * correct by construction.
 *
 * The signature covers exactly what a snapshot would look like differently:
 * - the frame it belongs to,
 * - every live stroke's geometry, colour and width,
 * - whether the user has an element selection (an element in the prompt is a new action).
 */

import type { Annotation, AnnotationShape } from "@mystudio/protocol";

/** One thing that makes a snapshot different from the previous one. */
export interface SnapshotSignatureInput {
  readonly compositionPath: string;
  readonly time: number;
  readonly strokes: readonly AnnotationShape[];
}

/**
 * A stable string for "what this frame looks like right now".
 *
 * Numbers are rounded to the same precision the store keeps them at, so float noise cannot
 * produce a false "changed" and force a pointless re-render.
 */
export function snapshotSignature(input: SnapshotSignatureInput): string {
  const strokes = input.strokes
    .filter((shape) => shape.kind === "freehand")
    .map((shape) => {
      if (shape.kind !== "freehand") return "";
      const points = shape.points
        .map((point) => `${round(point.x)},${round(point.y)},${round(point.pressure ?? -1)}`)
        .join(" ");
      return `[${shape.colour ?? ""}/${shape.width ?? ""}:${points}]`;
    })
    .join("|");

  /*
   * Only what the picture would show.
   *
   * The selected element used to be part of this, on the theory that "a different element is a
   * different picture". But a capture is only ever taken for **handwriting** — an element brings
   * its own frame image — so the selection cannot change whether a capture is needed, and
   * including it made the signature depend on something the picture does not contain
   * (found.md F-122).
   */
  return [input.compositionPath, round(input.time), strokes].join("#");
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "0";
}

/**
 * Live ink on one frame, in painting order.
 *
 * Withdrawn strokes are excluded: the picture must not show marks the user removed, which is
 * the same rule the delivered bundle applies.
 */
export function liveStrokesOn(
  annotations: readonly Annotation[],
  compositionPath: string,
  time: number,
): AnnotationShape[] {
  return annotations
    .filter(
      (annotation) =>
        !annotation.withdrawn &&
        annotation.shape.kind === "freehand" &&
        annotation.frame.compositionPath === compositionPath &&
        Math.abs(annotation.frame.time - time) < 0.0005,
    )
    .map((annotation) => annotation.shape);
}

/**
 * Identity of a selected element, for the signature.
 *
 * Stable id first: it survives reflow, while a selector can match several nodes.
 */
export function selectionKeyOf(target: {
  readonly hfId?: string | null;
  readonly id?: string | null;
  readonly selector?: string | null;
  readonly selectorIndex?: number | null;
} | null | undefined): string | null {
  if (!target) return null;
  if (target.hfId) return `hf:${target.hfId}`;
  if (target.id) return `id:${target.id}`;
  if (target.selector) return `sel:${target.selector}#${target.selectorIndex ?? 0}`;
  return null;
}

/**
 * Whether a `Capture` block is the right block for this frame.
 *
 * ## The rule
 *
 * Only **handwriting** produces a capture. Ink has no reference to name — it cannot be
 * `Arrow 2` — so the picture of the frame *is* its content, and `Capture N` is how the user can
 * see it and remove it.
 *
 * Everything else already owns a block **and** carries its own picture:
 *
 * | action | block | its picture |
 * |---|---|---|
 * | freehand stroke | `Capture N` | the block itself |
 * | region / arrow | `Region N` / `Arrow N` | `frameImagePath` on that block |
 * | element selection | `Element N` | `frameImagePath` on that block |
 *
 * So a capture beside a region, an arrow or an element adds a **second copy of the same image**
 * and makes one action read as two requests. That is exactly what the user saw: `Element 1` and
 * `Capture 2` for a single `Ctrl+S` on a selected element (found.md F-122).
 */
export function needsCapture(
  annotations: Parameters<typeof liveStrokesOn>[0],
  frame: { readonly compositionPath: string; readonly time: number },
): boolean {
  return liveStrokesOn(annotations, frame.compositionPath, frame.time).length > 0;
}
