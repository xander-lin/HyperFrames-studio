/**
 * Board wiring: pages, the pen, and what happens to a stroke.
 *
 * Kept out of `mount.tsx` because `mount.tsx` is a composition root — one file that
 * assembles every part — and adding page navigation, pen state and eraser routing there
 * would bury the assembly under one feature's details.
 *
 * ## What this hook decides, and what it does not
 *
 * It owns **where a board stroke goes**: which page, with which pen, and whether the
 * eraser found anything. It does not own how a stroke looks (that is `ink.ts`) or how a
 * page is stored (that is `boardStore.ts`).
 *
 * ## Pages are the board's own
 *
 * The current page comes from the store, not from the video's playhead. The earlier design
 * derived pages from the timeline's scenes, which gave the deck whatever page count the
 * project happened to have cuts for — a cap nobody asked for, and a page turn that moved
 * the video. Now the deck is independent: `addPage` appends, `stepPage` moves.
 *
 * ## Why the eraser is a hit test rather than a document action
 *
 * `eraseAtPoint` removes what the pointer touched, exactly like the video's eraser. A
 * "clear the page" button exists separately, because those are two different intents:
 * fixing a stroke, and starting over. Merging them would make a mis-click on an empty area
 * wipe the page.
 */

import { useCallback, useMemo } from "react";
import type { AnnotationShape } from "@mystudio/protocol";
import { shapeContains } from "./hitTest.js";
import type { PenStyle } from "./penStyle.js";
import { useBoardStore, type BoardMark } from "./boardStore.js";

export interface UseBoardResult {
  readonly marks: readonly BoardMark[];
  /** Whether the surface has anything to clear (current page). */
  readonly hasInk: boolean;
  readonly pen: PenStyle;
  readonly setPen: (pen: PenStyle) => void;
  /** Add a finished stroke to the current page. */
  readonly handleStroke: (shape: AnnotationShape) => void;
  /** Erase what the pointer touched. Returns whether anything was hit. */
  readonly eraseAtPoint: (point: { x: number; y: number }, tolerance: number) => boolean;
  /** Clear the current page only. Returns how many strokes were removed. */
  readonly clearPage: () => number;
  /** Undo the newest stroke on the current page. */
  readonly undoPage: () => boolean;
}

export function useBoard(): UseBoardResult {
  const pages = useBoardStore((state) => state.pages);
  const current = useBoardStore((state) => state.current);
  const addStroke = useBoardStore((state) => state.addStroke);
  const eraseStroke = useBoardStore((state) => state.eraseStroke);
  const clearPageAction = useBoardStore((state) => state.clearPage);
  const undoPageAction = useBoardStore((state) => state.undoPage);
  const pen = useBoardStore((state) => state.pen);
  const setPen = useBoardStore((state) => state.setPen);

  const marks = useMemo(
    () => pages.find((page) => page.key === current)?.marks ?? [],
    [pages, current],
  );

  const handleStroke = useCallback(
    (shape: AnnotationShape) => {
      /*
       * Every tool works on paper, including the region and the arrow.
       *
       * They used to be refused here, on the reasoning that a shape on a page "would have
       * to become a numbered block". It would not: a page has no prompt, so nothing refers
       * to the shape and it simply is not numbered. Refusing it took away the two most
       * useful sketch gestures — boxing a paragraph, pointing at where something should go
       * — for a consequence that never happens.
       */
      addStroke(current, shape);
    },
    [addStroke, current],
  );

  const eraseAtPoint = useCallback(
    (point: { x: number; y: number }, tolerance: number) => {
      /*
       * Topmost first: the ink drawn last is the one the user sees under the pointer, so
       * erasing from the end is what makes the result match the picture.
       */
      for (let index = marks.length - 1; index >= 0; index -= 1) {
        const mark = marks[index];
        if (!mark) continue;
        if (!shapeContains(mark.stroke, point, tolerance)) continue;
        eraseStroke(current, mark.id);
        return true;
      }
      return false;
    },
    [marks, eraseStroke, current],
  );

  const clearPage = useCallback(() => clearPageAction(current), [clearPageAction, current]);
  const undoPage = useCallback(() => undoPageAction(current), [undoPageAction, current]);

  return {
    marks,
    hasInk: marks.length > 0,
    pen,
    setPen,
    handleStroke,
    eraseAtPoint,
    clearPage,
    undoPage,
  };
}
