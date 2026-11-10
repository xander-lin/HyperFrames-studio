/**
 * Annotation collection store.
 *
 * zustand (Studio already uses it) because annotation state is shared across
 * components: toolbar, overlay, list and send button all read the same copy.
 *
 * It stores **marks that are on the frame**. Drawing is immediate: the moment a
 * stroke ends it becomes an annotation here. There is no "draft awaiting a note"
 * step — that popup was friction, and a stroke the user just drew is by definition
 * the stroke they meant.
 *
 * Binding is a separate axis: an annotation exists on the frame whether or not it
 * is part of the prompt. Only `boundIds` are delivered.
 */

import { create } from "zustand";
import type { Annotation, AnnotationShape, ElementRef, FrameRef } from "@mystudio/protocol";
import { shapeContains } from "./hitTest.js";

/** What the drawing layer hands over when a stroke ends. */
export interface NewAnnotation {
  readonly shape: AnnotationShape;
  readonly frame: FrameRef;
  readonly element?: ElementRef;
}

/** Outcome of undoing or erasing, so the caller can paint the affected blocks. */
export type RetractOutcome = "withdrawn" | "removed" | "none";

/**
 * One undoable step.
 *
 * The history stores **the marks that changed**, not a snapshot of the whole list:
 * `before` is what those marks looked like prior to the action, `after` is what they
 * become. Undo puts `before` back, redo puts `after` back. Snapshots of the whole
 * annotation list would also be correct, but they make every keystroke-sized change
 * cost a full copy and, worse, they silently discard unrelated future changes.
 */
export interface HistoryEntry {
  /**
   * Marks this action **created**. Undo deletes them; redo inserts them back.
   *
   * Separate from `removed` because the two are mirror images: drawing adds, erasing
   * deletes, and an undo has to do the opposite of whichever happened. Collapsing them
   * into one field made "undo a drawing" a no-op, which is exactly how the bug showed
   * up — the history recorded the action and then could not reverse it.
   */
  readonly added: readonly Annotation[];
  /** Marks this action **deleted**. Undo restores them; redo deletes them again. */
  readonly removed: readonly Annotation[];
  /** Marks whose fields changed, with their previous state. */
  readonly changed: readonly { readonly before: Annotation; readonly after: Annotation }[];
  /** The user-facing name of the action, for the toolbar's tooltip. */
  readonly label: string;
}

interface AnnotationStore {
  readonly annotations: readonly Annotation[];
  readonly boundIds: readonly string[];
  /** Undo stack, oldest first. */
  readonly past: readonly HistoryEntry[];
  /** Redo stack, most recently undone last. */
  readonly future: readonly HistoryEntry[];

  /** Record a finished stroke. Returns the created annotation. */
  add: (input: NewAnnotation) => Annotation;
  /**
   * Bind an annotation into this delivery. Idempotent.
   *
   * Binding says **that** the mark is part of the request, not where in it: the order is the
   * request's own list (`requestOrder.ts`), and the number is a position in that. Storing a
   * number here would be a second definition of the same fact, and a deletion would have to
   * rewrite it (found.md F-107, F-118).
   */
  bind: (id: string) => void;
  /** Remove a binding. */
  unbind: (id: string) => void;
  /**
   * Attach the saved capture path to an existing annotation.
   *
   * The capture is taken asynchronously after the stroke, so the path is not known
   * at creation time.
   */
  setFrameImagePath: (id: string, path: string) => void;
  /** Edit an annotation's note in place. */
  updateNote: (id: string, note: string) => void;
  /**
   * Undo the last **drawing** action.
   *
   * Scope is deliberately the shapes: adding a mark, erasing, clearing. It is not a text
   * editor's undo — the prompt box owns its own stack, and mixing the two is what made
   * `Ctrl+Z` feel broken (it was undoing typed words instead of the line just drawn).
   *
   * A mark that is already in the prompt is **withdrawn**, not deleted: its block stays
   * and turns red, because the user's sentence still names it and renumbering the later
   * blocks would repoint that sentence.
   */
  undo: () => RetractOutcome;
  /**
   * Retract every mark whose geometry touches a point, for the eraser.
   *
   * Returns the ids it hit (in store order) so the caller can report what happened.
   */
  eraseAt: (point: { x: number; y: number }, tolerance: number) => readonly string[];
  /** Retract every mark, at every timecode. Returns how many were touched. */
  clear: () => number;
  /** Remove one annotation outright, including its binding. */
  remove: (id: string) => void;
  /** Re-apply the last undone drawing action. */
  redo: () => RetractOutcome;
  /** Drop both stacks — for a new project or after delivery. */
  resetHistory: () => void;
}

let seq = 0;

/** Project-local annotation id: timestamp plus a counter — readable and unique. */
function nextId(): string {
  seq += 1;
  return `ann_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** Replace one annotation in a list, leaving the rest untouched. */
function patch(
  annotations: readonly Annotation[],
  id: string,
  change: Partial<Annotation>,
): readonly Annotation[] {
  return annotations.map((annotation) =>
    annotation.id === id ? { ...annotation, ...change } : annotation,
  );
}

interface Slice {
  readonly annotations: readonly Annotation[];
  readonly boundIds: readonly string[];
}

/**
 * Retract a set of marks: bound ones are withdrawn, unbound ones disappear.
 *
 * One implementation for undo, eraser, clear-at-time and clear — if they diverged,
 * the same gesture would behave differently depending on which button was used.
 */
function retract(state: Slice, ids: readonly string[]): Slice {
  const doomed = new Set(ids);
  const bound = new Set(state.boundIds);
  const kept: Annotation[] = [];
  for (const annotation of state.annotations) {
    if (!doomed.has(annotation.id)) {
      kept.push(annotation);
    } else if (bound.has(annotation.id)) {
      kept.push({ ...annotation, withdrawn: true });
    }
  }
  // Keep the binding: the block is still in the prompt, just marked gone.
  return { annotations: kept, boundIds: state.boundIds };
}

/** Cap the history so a long session cannot grow without bound. */
const HISTORY_LIMIT = 200;

/**
 * Apply one history step forward or backward.
 *
 * `forward` re-applies `after` (redo); the default puts `before` back (undo). Marks
 * that were removed are restored at the position implied by their `createdAt`, so the
 * badge order comes back exactly as it was rather than being appended at the end —
 * block references are positional, and reordering them would repoint the user's text.
 */
function step(state: Slice, entry: HistoryEntry, forward: boolean): Slice {
  const annotations = [...state.annotations];
  const boundIds = [...state.boundIds];

  // Changed marks: swap the field values.
  for (const change of entry.changed) {
    const index = annotations.findIndex((annotation) => annotation.id === change.after.id);
    if (index === -1) continue;
    annotations[index] = forward ? change.after : change.before;
  }

  /*
   * `removed` records marks that **do not exist after** this action.
   *
   * That covers two different actions with one rule:
   * - drawing a mark (`add`): it does not exist before, so undo deletes it;
   * - erasing one (`eraseAt` / `clear` / `remove`): it exists before, so undo restores it.
   *
   * Both are "the forward direction ends with the mark gone", which is why a single
   * branch handles them and why undo must be the mirror image: `forward` deletes,
   * `!forward` restores. An earlier version restored on undo but never deleted on the
   * forward pass, so drawing was recorded as undoable and then not actually undone.
   */
  /**
   * Insert a mark where its creation time says it belongs.
   *
   * Not appended: block ordinals are positional, and putting a restored mark at the end
   * would renumber everything after it, silently repointing the user's sentence.
   */
  const restore = (annotation: Annotation): void => {
    if (annotations.some((candidate) => candidate.id === annotation.id)) return;
    const at = annotations.findIndex((candidate) => candidate.createdAt > annotation.createdAt);
    if (at === -1) annotations.push(annotation);
    else annotations.splice(at, 0, annotation);
  };

  const drop = (annotation: Annotation): void => {
    const index = annotations.findIndex((candidate) => candidate.id === annotation.id);
    if (index !== -1) annotations.splice(index, 1);
  };

  if (forward) {
    // Redo: created marks exist again, deleted ones disappear again.
    for (const annotation of entry.added) restore(annotation);
    for (const annotation of entry.removed) drop(annotation);
  } else {
    // Undo: created marks disappear, deleted ones come back.
    for (const annotation of entry.added) drop(annotation);
    for (const annotation of entry.removed) restore(annotation);
  }

  return { annotations, boundIds };
}

/**
 * Record a step and return the new stacks.
 *
 * Redo is discarded on every new action: once the user draws again, the branch they
 * had undone is gone. Keeping it would mean redo could resurrect a mark on top of
 * newer work.
 */
function pushHistory(
  past: readonly HistoryEntry[],
  entry: HistoryEntry | null,
): { past: readonly HistoryEntry[]; future: readonly HistoryEntry[] } {
  if (!entry) return { past, future: [] };
  const next = [...past, entry];
  return {
    past: next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next,
    future: [],
  };
}

export const useAnnotationStore = create<AnnotationStore>((set, get) => ({
  annotations: [],
  boundIds: [],
  past: [],
  future: [],

  add: (input) => {
    const annotation: Annotation = {
      id: nextId(),
      shape: input.shape,
      frame: input.frame,
      note: "",
      createdAt: Date.now(),
      ...(input.element ? { element: input.element } : {}),
    };
    set((state) => {
      /* A new mark is undoable as "this mark appeared"; redo puts it back verbatim. */
      const entry: HistoryEntry = {
        added: [annotation],
        removed: [],
        changed: [],
        label: `Draw ${annotation.shape.kind}`,
      };
      const history = pushHistory(state.past, entry);
      return { ...state, annotations: [...state.annotations, annotation], ...history };
    });
    return annotation;
  },

  bind: (id) =>
    set((state) => {
      if (state.boundIds.includes(id)) return state;
      return { ...state, boundIds: [...state.boundIds, id] };
    }),

  unbind: (id) =>
    set((state) => ({ ...state, boundIds: state.boundIds.filter((value) => value !== id) })),

  setFrameImagePath: (id, path) =>
    set((state) => ({
      ...state,
      annotations: patch(state.annotations, id, { frameImagePath: path }),
    })),

  updateNote: (id, note) =>
    set((state) => ({ ...state, annotations: patch(state.annotations, id, { note }) })),

  undo: () => {
    const state = get();
    const entry = state.past[state.past.length - 1];
    if (!entry) return "none";

    /*
     * Undoing a drawing whose mark is **already in the prompt** must withdraw it, not
     * delete it: the user's sentence names that block, and removing it would renumber
     * every later one. This is a fact about the state at undo time, not about the
     * action, so it is decided here rather than baked into the entry.
     */
    const createdBound = entry.added.filter((annotation) =>
      state.boundIds.includes(annotation.id),
    );
    if (createdBound.length > 0) {
      const changed = createdBound.map((annotation) => ({
        before: { ...annotation, withdrawn: true },
        after: annotation,
      }));
      const withdrawEntry: HistoryEntry = {
        added: [],
        removed: [],
        // `before` is the withdrawn form because `step(forward=false)` writes `before`.
        changed,
        label: entry.label,
      };
      const next = step(state, withdrawEntry, false);
      set({
        ...next,
        past: state.past.slice(0, -1),
        future: [...state.future, withdrawEntry],
      });
      return "withdrawn";
    }

    const next = step(state, entry, false);
    set({
      ...next,
      past: state.past.slice(0, -1),
      future: [...state.future, entry],
    });
    /*
     * "withdrawn" only when the action was a **retraction of a bound mark**, because
     * that is the only case where the block stays in the prompt and turns red. Undoing
     * a drawing deletes the mark outright — it was never in the prompt unless the user
     * pressed S, and if it was, the retraction path below is what recorded it.
     */
    return entry.changed.length > 0 ? "withdrawn" : "removed";
  },

  redo: () => {
    const state = get();
    const entry = state.future[state.future.length - 1];
    if (!entry) return "none";

    const next = step(state, entry, true);
    set({
      ...next,
      past: [...state.past, entry],
      future: state.future.slice(0, -1),
    });
    return entry.changed.length > 0 ? "withdrawn" : "removed";
  },

  resetHistory: () => set((state) => ({ ...state, past: [], future: [] })),

  eraseAt: (point, tolerance) => {
    const state = get();
    const hits = state.annotations.filter(
      (annotation) => !annotation.withdrawn && shapeContains(annotation.shape, point, tolerance),
    );
    if (hits.length === 0) return [];

    const ids = hits.map((annotation) => annotation.id);
    retractWithHistory(set, get, ids, "Erase");
    return ids;
  },

  clear: () => {
    const state = get();
    const live = state.annotations.filter((annotation) => !annotation.withdrawn);
    if (live.length === 0) return 0;

    retractWithHistory(set, get, live.map((annotation) => annotation.id), "Clear all marks");
    return live.length;
  },

  remove: (id) =>
    set((state) => {
      const removed = state.annotations.find((annotation) => annotation.id === id);
      /*
       * A no-op is a no-op. Recording nothing must not discard the redo branch either:
       * "remove" on an id that is already gone means the user's next Ctrl+Shift+Z should
       * still work.
       */
      if (!removed) return state;
      const history = pushHistory(state.past, {
        added: [],
        removed: [removed],
        changed: [],
        label: "Remove block",
      });
      return {
        ...state,
        annotations: state.annotations.filter((annotation) => annotation.id !== id),
        boundIds: state.boundIds.filter((value) => value !== id),
        ...history,
      };
    }),
}));

/**
 * Retract marks and record it as one undoable step.
 *
 * A retraction has two shapes: unbound marks disappear (recorded in `removed`), bound
 * marks only gain `withdrawn: true` (recorded as a field change). Undo therefore either
 * restores the mark or just clears the flag, and both cases need no special-casing at
 * the call site.
 */
function retractWithHistory(
  set: (partial: Partial<AnnotationStore>) => void,
  get: () => AnnotationStore,
  ids: readonly string[],
  label: string,
): void {
  const state = get();
  const doomed = new Set(ids);

  const removed: Annotation[] = [];
  const changed: Array<{ before: Annotation; after: Annotation }> = [];
  for (const annotation of state.annotations) {
    if (!doomed.has(annotation.id)) continue;
    if (state.boundIds.includes(annotation.id) && !annotation.withdrawn) {
      changed.push({ before: annotation, after: { ...annotation, withdrawn: true } });
    } else if (!state.boundIds.includes(annotation.id)) {
      removed.push(annotation);
    }
  }

  const next = retract(state, ids);
  const history = pushHistory(
    state.past,
    removed.length === 0 && changed.length === 0 ? null : { added: [], removed, changed, label },
  );
  set({ ...next, ...history });
}

/**
 * Whether there is anything to undo or redo.
 *
 * Derived rather than stored: a `canUndo` field could disagree with the stack it
 * describes, and that disagreement shows up as a button that looks enabled and does
 * nothing.
 */
export const selectCanUndo = (state: AnnotationStore): boolean => state.past.length > 0;
export const selectCanRedo = (state: AnnotationStore): boolean => state.future.length > 0;
