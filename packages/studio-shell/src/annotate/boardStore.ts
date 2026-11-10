/**
 * The whiteboard: pages of sketch ink, kept entirely apart from the video.
 *
 * ## What this is for
 *
 * Sometimes the thing to explain is not on the frame. You want to draw the shape you mean,
 * sketch a layout, or write the sentence in hand — and doing it on top of the footage is
 * worse than useless, because the picture fights the ink and the ink lands in the
 * delivered prompt as an annotation of the frame.
 *
 * So the board is a **temporary blank page the size of the video**: the video is swapped
 * out, you draw, and you can switch back without either side losing anything.
 *
 * ## The rules, and why they are structural rather than careful
 *
 * The requirement is that the two sides never interfere: clearing the video leaves the
 * board alone, clearing the board leaves the video alone, and erasing on one cannot touch
 * the other. The cheapest way to guarantee that is not to filter at every operation — that
 * is one forgotten `filter` away from a bug — but to keep them in **separate stores**.
 * Board ink is not an annotation and never enters the annotation store, so no annotation
 * code path can see it, let alone delete it.
 *
 * The same separation is what keeps the board off the wire: a delivered prompt carries
 * annotations and composed frames, and board ink is neither. A sketch is a working note,
 * not a request.
 *
 * ## Pages belong to the board, not to the timeline
 *
 * An earlier version made the page follow the video's scenes: one scene, one page, and
 * therefore exactly as many pages as the timeline happened to have. That was wrong twice
 * over.
 *
 * - **It invented a page limit.** The deck's page count became whatever number of scenes
 *   the project had, so a board could never have more pages than the video had cuts. The
 *   user saw "11 pages" and reasonably asked why there was a cap at all.
 * - **It coupled two unrelated things.** Sketching a plan on paper has nothing to do with
 *   where the playhead is; turning a page moved the video, which nobody asked for.
 *
 * A board is now a deck of its own: it starts with one page, `addPage` appends, and the
 * page is identified by a stable id. Nothing about it is derived from the timeline.
 */

import { create } from "zustand";
import type { AnnotationShape } from "@mystudio/protocol";
import type { PenStyle } from "./penStyle.js";

/**
 * A mark on a page: ink, a box, or an arrow.
 *
 * Any shape is allowed. What a page does **not** have is a prompt, so nothing here is
 * numbered or delivered — the restriction was never about the type, it was about the
 * reference, and the reference does not exist on a page.
 */
export type BoardStroke = AnnotationShape;

/** One mark, with an id so it can be erased individually and undone. */
export interface BoardMark {
  readonly id: string;
  readonly stroke: BoardStroke;
}

/** Ink on one page. */
export interface BoardPage {
  /**
   * Stable page identity.
   *
   * An opaque id rather than a position: deleting or inserting a page must not move
   * existing sketches to a different sheet. It is also what the per-page undo history and
   * the "which page is showing" pointer are keyed by, so those follow the page rather than
   * its number.
   */
  readonly key: string;
  readonly marks: readonly BoardMark[];
}

/** A page's number in the deck, one-based, for display. */
export function pageNumberOf(pages: readonly BoardPage[], key: string): number {
  const index = pages.findIndex((page) => page.key === key);
  return index < 0 ? 1 : index + 1;
}

interface BoardStore {
  /** "board" shows the page; "video" shows the picture. */
  readonly mode: "video" | "board";
  /**
   * The pen the board draws with.
   *
   * On the board store rather than in the annotation layer's state because the two
   * surfaces want different pens: board ink is often black on paper, while video ink has
   * to stay legible over footage. Sharing one setting would mean changing it in one place
   * silently changes the other.
   */
  readonly pen: PenStyle;
  readonly pages: readonly BoardPage[];
  /** The page currently showing, by key. */
  readonly current: string;
  /** Undo stack per page key: the strokes each action added, oldest first. */
  readonly history: Readonly<Record<string, readonly (readonly string[])[]>>;

  setMode: (mode: "video" | "board") => void;
  toggleMode: () => void;
  setPen: (pen: PenStyle) => void;
  /** Show a page by key. Does nothing for an unknown key. */
  setCurrent: (key: string) => void;
  /** Step one page. Bounded: the deck ends are ends, not a loop. */
  stepPage: (delta: -1 | 1) => boolean;
  /** Append an empty page after the current one and show it. Returns its key. */
  addPage: () => string;
  /** Remove the current page. The deck always keeps at least one page. */
  removeCurrentPage: () => boolean;
  /** Add a stroke to a page, creating the page if needed. Returns its id. */
  addStroke: (key: string, stroke: BoardStroke) => string;
  /** Remove one stroke from a page. Returns whether anything was removed. */
  eraseStroke: (key: string, id: string) => boolean;
  /** Clear one page. Returns how many strokes were removed. */
  clearPage: (key: string) => number;
  /** Undo the last stroke added to a page. */
  undoPage: (key: string) => boolean;
  /** Strokes on one page, in painting order. */
  strokesOf: (key: string) => readonly BoardMark[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** The first page's key, used so a fresh board is a single sheet rather than zero. */
const FIRST_PAGE = "page_1";

/**
 * The board store.
 *
 * Deliberately **not** the annotation store. Two independent stores cannot interfere by
 * accident, which is the requirement: no shared array, no shared clear, no shared history.
 */
export const useBoardStore = create<BoardStore>((set, get) => ({
  mode: "video",
  // Black on paper: the board is for writing, and red-on-white reads as a correction.
  pen: { colour: "#101114", width: 3 },
  /*
   * A board is never empty of pages. Starting at zero would mean the first stroke has to
   * create a page, and "which page am I on" would have to answer "none" — a state the UI
   * would then have to special-case everywhere.
   */
  pages: [{ key: FIRST_PAGE, marks: [] }],
  current: FIRST_PAGE,
  history: {},

  setMode: (mode) => set((state) => ({ ...state, mode })),
  toggleMode: () => set((state) => ({ ...state, mode: state.mode === "board" ? "video" : "board" })),
  setPen: (pen) => set((state) => ({ ...state, pen })),

  setCurrent: (key) =>
    set((state) => (state.pages.some((page) => page.key === key) ? { ...state, current: key } : state)),

  stepPage: (delta) => {
    const state = get();
    const index = state.pages.findIndex((page) => page.key === state.current);
    const next = state.pages[index + delta];
    if (!next) return false;
    set({ ...state, current: next.key });
    return true;
  },

  addPage: () => {
    const key = nextId("page");
    set((state) => {
      const index = state.pages.findIndex((page) => page.key === state.current);
      const pages = [...state.pages];
      // Insert after the current page, so "new page" continues the deck where the user is
      // rather than appending somewhere they cannot see.
      pages.splice(index + 1, 0, { key, marks: [] });
      return { ...state, pages, current: key };
    });
    return key;
  },

  removeCurrentPage: () => {
    const state = get();
    // One page always remains: an empty deck has no surface to draw on.
    if (state.pages.length <= 1) return false;
    const index = state.pages.findIndex((page) => page.key === state.current);
    const pages = state.pages.filter((page) => page.key !== state.current);
    const next = pages[Math.min(index, pages.length - 1)];
    const history = { ...state.history };
    delete history[state.current];
    set({ ...state, pages, current: next?.key ?? FIRST_PAGE, history });
    return true;
  },

  addStroke: (key, stroke) => {
    const id = nextId("bd");
    set((state) => {
      const existing = state.pages.some((page) => page.key === key);
      const pages = existing
        ? state.pages.map((page) =>
            page.key === key ? { ...page, marks: [...page.marks, { id, stroke }] } : page,
          )
        : [...state.pages, { key, marks: [{ id, stroke }] }];
      const stack = state.history[key] ?? [];
      return {
        ...state,
        pages,
        history: { ...state.history, [key]: [...stack, [id]] },
      };
    });
    return id;
  },

  eraseStroke: (key, id) => {
    const state = get();
    const page = state.pages.find((candidate) => candidate.key === key);
    if (!page?.marks.some((mark) => mark.id === id)) return false;
    set({
      ...state,
      pages: state.pages.map((candidate) =>
        candidate.key === key
          ? { ...candidate, marks: candidate.marks.filter((mark) => mark.id !== id) }
          : candidate,
      ),
      // Erasing is its own action with its own history entry: it is not undoable by the
      // stroke undo, because "put back what I just erased" is a different request from
      // "remove what I just drew".
      history: { ...state.history, [key]: [...(state.history[key] ?? []), []] },
    });
    return true;
  },

  clearPage: (key) => {
    const state = get();
    const page = state.pages.find((candidate) => candidate.key === key);
    const count = page?.marks.length ?? 0;
    if (count === 0) return 0;
    set({
      ...state,
      pages: state.pages.map((candidate) =>
        candidate.key === key ? { ...candidate, marks: [] } : candidate,
      ),
      history: { ...state.history, [key]: [...(state.history[key] ?? []), []] },
    });
    return count;
  },

  undoPage: (key) => {
    const state = get();
    const stack = state.history[key] ?? [];
    const last = stack[stack.length - 1];
    if (!last || last.length === 0) return false;
    const doomed = new Set(last);
    set({
      ...state,
      pages: state.pages.map((candidate) =>
        candidate.key === key
          ? { ...candidate, marks: candidate.marks.filter((mark) => !doomed.has(mark.id)) }
          : candidate,
      ),
      history: { ...state.history, [key]: stack.slice(0, -1) },
    });
    return true;
  },

  strokesOf: (key) => get().pages.find((page) => page.key === key)?.marks ?? [],
}));

/** Whether a page has anything on it, for the UI's "clear" button state. */
export const selectPageHasInk = (key: string) => (state: BoardStore): boolean =>
  (state.pages.find((page) => page.key === key)?.marks.length ?? 0) > 0;
