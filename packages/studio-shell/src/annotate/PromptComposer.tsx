/**
 * The prompt editor.
 *
 * ## One document, not two
 *
 * This is a ProseMirror editor. That is the architectural answer to three defects that had a
 * single cause: **the old box kept two copies of one document** — a plain string for the
 * delivery and a segment tree rebuilt into a `contenteditable` whenever either changed.
 *
 * | Reported symptom | Cause under two representations |
 * |---|---|
 * | a chip silently turned into plain text | the DOM was rebuilt by parsing the string and asking "is this line a block?", so any numbering drift dropped the block's identity (found.md F-108) |
 * | deleting a block threw the caret to the front | deletion rewrote the string → full DOM rebuild → the caret's node was destroyed (found.md F-116, F-117) |
 * | "where was the cursor" was always a guess | after every rebuild the caret had to be *reconstructed* |
 *
 * Here the document **is** the tree. A block is a node type, so it cannot degrade into
 * characters; an edit is a transaction whose selection is mapped by the library, so nothing
 * has to be reconstructed (found.md F-118).
 *
 * ## Division of ownership
 *
 * The composer owns **the text**; typing happens here and the document is the truth.
 * The caller owns **which blocks the request names**, passed in as `targets`.
 *
 * They meet in exactly one place: `reconcileTransaction`, which inserts and deletes *block
 * nodes only*. It never rewrites text, so a deletion moves the document by one node and the
 * caret by nothing.
 */

import { useCallback, useEffect, useRef } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap, selectAll } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { blockNodeView, repaintBlocks, type BlockState } from "./promptNodeView.js";
import { removeBlockCommand } from "./promptBlockKeys.js";
import { heldEditorState, holdEditorState } from "./promptDocumentStore.js";
import { reconcileTransaction } from "./promptReconcile.js";
import {
  blocksOf,
  blockParagraph,
  isEmptyDoc,
  plainTextOf,
  promptSchema,
  targetKey,
  type BlockTarget,
} from "./promptSchema.js";

export interface PromptComposerProps {
  /**
   * The blocks this request names, **in numbering order**.
   *
   * Ordered by the caller because a number *is* a position: the first entry is `… 1`. The
   * composer inserts and deletes nodes to match this list; it never reorders the text the user
   * typed around them.
   */
  readonly targets: readonly BlockTarget[];
  /** Store state per block, for the red "withdrawn" appearance. */
  readonly states: ReadonlyMap<string, BlockState>;
  /** The document's text, after every change. This is what gets delivered. */
  readonly onTextChange: (text: string) => void;
  /** The user deleted a block in the box: drop it from the request. */
  readonly onRemoveBlock: (target: BlockTarget) => void;
  readonly onSend: () => void;
  readonly delivering: boolean;
  readonly canSend: boolean;
}

/** The attribute the runtime checks, the layout and the selection guard look for. */
const BOX_ATTR = "compose-input";

export function PromptComposer(props: PromptComposerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  /**
   * Set while this component edits the document to match `targets`.
   *
   * Reconciliation deletes nodes the caller already asked about. Without this flag those
   * deletions would be reported back as if the user had pressed Backspace, and the caller
   * would try to remove things twice (found.md F-118).
   */
  const applying = useRef(false);

  /** The latest props, for callbacks the editor created once and holds on to. */
  const latest = useRef(props);
  latest.current = props;

  /** Targets the document held before the last transaction, for detecting removals. */
  const previousTargets = useRef<BlockTarget[]>([]);

  /**
   * Report the document's text, and any block the **user** removed.
   *
   * Called after every transaction the editor applies. The only subtlety is telling a removal
   * the user made from one this component made to match `targets`: `applying` marks the
   * second, so it is never reported back as a user action.
   */
  const publish = useCallback((doc: EditorState["doc"]) => {
    const current = blocksOf(doc).map((block) => block.target);
    const previous = previousTargets.current;
    previousTargets.current = current;

    latest.current.onTextChange(plainTextOf(doc));
    if (applying.current) return;

    const now = new Set(current.map(targetKey));
    for (const target of previous) {
      if (!now.has(targetKey(target))) latest.current.onRemoveBlock(target);
    }
  }, []);

  // ── mount once ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /*
     * Adopt the document the box had last time, or start a new one.
     *
     * The panel is unmounted whenever the layer is deactivated, so a fresh `EditorState` here
     * would silently discard everything the user had typed. The held copy is the same document
     * continuing, which is also why it is *not* rebuilt from `targets`: the text is the user's,
     * and the request is reconciled into it (found.md F-118).
     */
    const held = heldEditorState();
    const state = held ?? EditorState.create({
      schema: promptSchema,
      doc: documentFromTargets(latest.current.targets),
      plugins: [
        history(),
        /*
         * Block deletion comes **before** the ordinary text keys.
         *
         * Backspace at a block must remove the block and its line; left to the default
         * handling, the editor removes the atom and keeps the empty paragraph, so the box
         * grows a blank line per deletion (found.md F-118).
         */
        keymap({
          Backspace: removeBlockCommand("backward"),
          Delete: removeBlockCommand("forward"),
        }),
        /*
         * `Ctrl+Z` inside the box is the **text's** undo, not the drawing's: the two are
         * different surfaces, and drawing undo is routed to the canvas by the shortcut policy
         * whenever the caret is not here (found.md F-097).
         */
        keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
        /*
         * `Ctrl+A` selects the text, which is what the field means by it.
         *
         * The shortcut policy already hands that chord back to a focused field (found.md
         * F-097) — and this is the other half of that promise: the field has to actually do
         * it. ProseMirror does not bind it by default, so without this line the key is handed
         * over and then dropped, and the user cannot select their own paragraph.
         */
        keymap({ "Mod-a": selectAll }),
        keymap(baseKeymap),
      ],
    });

    const view = new EditorView(host, {
      state,
      /*
       * Each block draws itself and repaints in place.
       *
       * The lookup is lazy on purpose: the editor is mounted once, while the withdrawn map is
       * replaced on every undo. Reading it per paint is what lets a chip turn red without the
       * editor being rebuilt — and rebuilding is the behaviour this design exists to remove.
       */
      nodeViews: {
        block: blockNodeView(() => latest.current.states),
      },
      attributes: {
        /*
         * The overlay attribute belongs on the **editable element**, not the host.
         *
         * Everything that looks for the prompt box — the layout, the runtime checks, the
         * selection guard — does `querySelector('[data-mystudio-overlay="compose-input"]')` and
         * then often `.focus()` or reads `document.activeElement`. On the host both fail: the
         * host is a plain div and cannot take focus, so the real caret lived one level below
         * whatever those callers were inspecting (found.md F-118).
         */
        "data-mystudio-overlay": BOX_ATTR,
        class: "ms-prompt",
        "data-placeholder": latest.current.targets.length > 0
          ? "Keep writing, then send"
          : "Draw a region or arrow, press S to add it here, then describe the change",
        spellcheck: "false",
        /*
         * What makes this a text field as far as the rest of the layer is concerned: the
         * canvas selection guard leaves drags that start here alone, and the shortcut policy
         * treats a caret in here as typing rather than as a command context.
         */
        "data-mystudio-selectable": "",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Prompt",
      },
      dispatchTransaction: (tr) => {
        const next = view.state.apply(tr);
        view.updateState(next);
        holdEditorState(next);

        if (tr.docChanged) publish(next.doc);
        /*
         * The class goes on the **editor's own element**, not the host: that element is what
         * carries `ms-prompt`, and the empty-state hint is a pseudo-element of it.
         */
        view.dom.classList.toggle("ms-prompt-empty", isEmptyState(next));
      },
    });

    viewRef.current = view;
    holdEditorState(view.state);
    previousTargets.current = blocksOf(view.state.doc).map((block) => block.target);
    latest.current.onTextChange(plainTextOf(view.state.doc));
    view.dom.classList.toggle("ms-prompt-empty", isEmptyState(view.state));

    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined || text === null) return;
      event.preventDefault();
      const selection = view.state.selection;
      if (text === "") {
        view.dispatch(view.state.tr.deleteSelection());
        return;
      }
      view.dispatch(view.state.tr.insertText(text, selection.from, selection.to));
    };
    host.addEventListener("paste", onPaste);

    return () => {
      host.removeEventListener("paste", onPaste);
      view.destroy();
      viewRef.current = null;
    };
    // Created once; everything that changes is read through `latest`. `publish` is stable.
  }, [publish]);

  // ── keep the document in step with the request ────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    applying.current = true;
    try {
      const tr = reconcileTransaction(view.state.doc, view.state.tr, props.targets);
      if (!tr) return;
      view.dispatch(tr);
      previousTargets.current = blocksOf(view.state.doc).map((block) => block.target);
      latest.current.onTextChange(plainTextOf(view.state.doc));
      /*
       * Repaint explicitly: a deletion renumbers every later block without changing those
       * nodes, so the editor has no reason to redraw them and their labels would keep the old
       * numbers (found.md F-121).
       */
      repaintBlocks(view, () => latest.current.states);
    } finally {
      applying.current = false;
    }
  }, [props.targets]);

  /**
   * Keep the placeholder in step with whether the request has blocks.
   *
   * The attribute is read by the CSS pseudo-element, so it has to change with the state — an
   * empty box with blocks waiting says something different from an empty box with none.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dom.setAttribute(
      "data-placeholder",
      props.targets.length > 0
        ? "Keep writing, then send"
        : "Draw a region or arrow, press S to add it here, then describe the change",
    );
  }, [props.targets]);


  /**
   * Repaint the chips when a mark is withdrawn or restored.
   *
   * ## Why this needs its own effect
   *
   * A chip's red state lives in the **store**, not in the document: undoing a drawing does not
   * edit the prompt. But a `NodeView.update` only runs when a transaction reaches the view, so
   * changing the map alone repainted nothing — the mark was correctly withdrawn and the block
   * stayed black, which reads as "the undo did not work" (found.md F-121).
   *
   * A no-op transaction is the editor's documented way to ask for a repaint: it changes no
   * document content, so it cannot move the caret, and `dispatchTransaction` is not what
   * repaints here — `updateState` is.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || applying.current) return;
    repaintBlocks(view, () => latest.current.states);
  }, [props.states]);

  const send = (): void => {
    if (!latest.current.canSend || latest.current.delivering) return;
    latest.current.onSend();
  };

  const disabled = !props.canSend || props.delivering;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 78 }}>
        {/*
          ProseMirror mounts into this element. The overlay attribute lives on the *host* so the
          runtime checks, layout and selection guard keep finding the prompt box where they
          always did.
        */}
        {/*
          ProseMirror mounts into this element, and **its** child is what carries the visible
          box: a focus ring belongs on the editable element, not on a wrapper, or the outline
          lands on a rectangle that is not where the caret is.
        */}
        <div ref={hostRef} style={{ height: "100%", minHeight: 78 }} />

        {/* Send circle: trailing the text, never its own row. */}
        <button
          type="button"
          data-mystudio-overlay="send"
          onClick={send}
          disabled={disabled}
          title={props.canSend ? "Send to OpenCode" : "Draw something first"}
          style={{
            position: "absolute",
            right: 6,
            bottom: 6,
            width: 22,
            height: 22,
            display: "grid",
            placeItems: "center",
            borderRadius: 999,
            border: "none",
            background: props.canSend ? "var(--color-accent)" : "var(--color-surface-alt)",
            color: props.canSend ? "var(--color-on-accent)" : "var(--color-text-off)",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 12,
            lineHeight: 1,
            padding: 0,
            boxShadow: props.canSend
              ? "0 2px 8px color-mix(in oklab, var(--color-accent) 40%, transparent)"
              : "none",
          }}
        >
          {props.delivering ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** A document holding one paragraph per target, which is the initial state. */
function documentFromTargets(targets: readonly BlockTarget[]) {
  const nodes = targets.map(blockParagraph);
  const paragraph = promptSchema.nodes["paragraph"]!.create();
  return promptSchema.nodes["doc"]!.create(null, nodes.length === 0 ? paragraph : nodes);
}

/** Delegate to the schema's own notion of "nothing here", so the two cannot differ. */
function isEmptyState(state: EditorState): boolean {
  return isEmptyDoc(state.doc);
}
