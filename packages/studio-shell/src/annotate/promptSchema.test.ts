import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { reconcileTransaction } from "./promptReconcile.js";
import {
  blocksOf,
  documentFor,
  labelForTarget,
  plainTextOf,
  promptSchema,
  targetKey,
  textOnlyOf,
  type BlockTarget,
} from "./promptSchema.js";

/**
 * The prompt document.
 *
 * ## What these tests are really about
 *
 * The box used to keep two copies of one document — a string for delivery and a segment tree
 * rebuilt into a `contenteditable`. Every defect it had came from that seam: a chip could
 * degrade into text when the numbering drifted (found.md F-108), and deleting a block rewrote
 * the string, which forced a rebuild that destroyed the caret's node (found.md F-116, F-117).
 *
 * So the properties worth pinning are about the **document**, not the DOM:
 *
 * 1. a block is a node, so its label can never become characters;
 * 2. the label comes from the node's **position**, so renumbering changes no text;
 * 3. reconciling against the request changes only block nodes, never a user's words.
 */

const capture = (id: string): BlockTarget => ({ kind: "capture", id });
const region = (id: string): BlockTarget => ({ kind: "annotation", id, shape: "region" });
const arrow = (id: string): BlockTarget => ({ kind: "annotation", id, shape: "arrow" });
const element = (id: string): BlockTarget => ({ kind: "element", id });
const drawing = (id: string): BlockTarget => ({ kind: "drawing", id });

/** A document holding the targets, one paragraph each. */
function docOf(targets: readonly BlockTarget[]): PMNode {
  return documentFor(targets);
}

/** A document holding `text` in one paragraph. */
function docWithText(text: string): PMNode {
  return promptSchema.nodes["doc"]!.create(
    null,
    promptSchema.nodes["paragraph"]!.create(null, text === "" ? undefined : promptSchema.text(text)),
  );
}

describe("labels", () => {
  it("numbers every kind from one sequence", () => {
    expect(labelForTarget(element("e"), 1)).toBe("Element 1");
    expect(labelForTarget(capture("c"), 2)).toBe("Capture 2");
    expect(labelForTarget(region("r"), 3)).toBe("Region 3");
    expect(labelForTarget(arrow("a"), 4)).toBe("Arrow 4");
  });

  it("distinguishes a region from an arrow, because a sentence may name either", () => {
    expect(labelForTarget(region("x"), 1)).not.toBe(labelForTarget(arrow("x"), 1));
  });

  it("calls a board page a Drawing, not a Capture", () => {
    /*
     * A whiteboard sketch is a block like any other, but it is not a moment of the video.
     * Naming it `Capture N` would claim there is footage behind it, and a reader would go
     * looking for that frame and find something else (found.md F-128).
     */
    expect(labelForTarget(drawing("d"), 1)).toBe("Drawing 1");
    expect(labelForTarget(drawing("d"), 1)).not.toBe(labelForTarget(capture("d"), 1));
  });

  it("keeps drawings in the one shared sequence", () => {
    const blocks = blocksOf(docOf([region("r"), drawing("d"), capture("c")]));
    expect(blocks.map((block) => block.label)).toEqual(["Region 1", "Drawing 2", "Capture 3"]);
  });
});

describe("blocks in a document", () => {
  it("reads them in order and numbers them from 1", () => {
    const blocks = blocksOf(docOf([element("e"), capture("c"), region("r")]));
    expect(blocks.map((block) => block.label)).toEqual(["Element 1", "Capture 2", "Region 3"]);
    expect(blocks.map((block) => block.ordinal)).toEqual([1, 2, 3]);
  });

  it("keeps a block's identity separate from its number", () => {
    /*
     * This is the property that makes deletion cheap: the node says *what* it is, and the
     * number is derived. Nothing has to be rewritten when the number changes.
     */
    const blocks = blocksOf(docOf([arrow("a1"), arrow("a2")]));
    expect(blocks.map((block) => targetKey(block.target))).toEqual(["annotation:a1", "annotation:a2"]);
    expect(blocks.map((block) => block.label)).toEqual(["Arrow 1", "Arrow 2"]);
  });

  it("renders a document with no blocks as its plain text", () => {
    expect(plainTextOf(docWithText("make the title bigger"))).toBe("make the title bigger");
  });

  it("substitutes labels only at the boundary, never into the document", () => {
    const doc = docOf([capture("c1")]);
    // The document itself holds no text at all.
    expect(doc.textContent).toBe("");
    // The delivered text does.
    expect(plainTextOf(doc)).toBe("Capture 1");
  });
});

describe("reconciling against the request", () => {
  /** Apply a reconciliation and return the resulting document. */
  function apply(doc: PMNode, desired: readonly BlockTarget[]): PMNode {
    const state = EditorState.create({ schema: promptSchema, doc });
    const tr = reconcileTransaction(doc, state.tr, desired);
    return tr ? tr.doc : doc;
  }

  it("adds a block the request names", () => {
    const after = apply(docWithText("move it left"), [region("r1")]);
    expect(blocksOf(after).map((block) => block.label)).toEqual(["Region 1"]);
    expect(textOnlyOf(after)).toContain("move it left");
  });

  it("removes a block the request no longer names", () => {
    const after = apply(docOf([region("r1"), arrow("a2")]), [arrow("a2")]);
    expect(blocksOf(after).map((block) => block.label)).toEqual(["Arrow 1"]);
  });

  it("renumbers without touching the document's text", () => {
    /*
     * The heart of the fix: deleting `Capture 1` renumbers `Capture 2` to `Capture 1`, and the
     * only document change is the one node that went away.
     */
    const before = docOf([capture("c1"), capture("c2")]);
    const after = apply(before, [capture("c2")]);
    expect(blocksOf(after).map((block) => block.label)).toEqual(["Capture 1"]);
  });

  it("renumbers a drawing like any other block when one before it is removed", () => {
    const before = docOf([region("r"), drawing("d")]);
    const after = apply(before, [drawing("d")]);
    expect(blocksOf(after).map((block) => block.label)).toEqual(["Drawing 1"]);
    // No user text anywhere: the document holds block nodes only.
    expect(textOnlyOf(after).trim()).toBe("");
  });

  it("does nothing at all when the request already matches", () => {
    /*
     * A no-op transaction is not harmless: dispatching one normalises the selection, which can
     * move the caret to the end. The caller must be able to skip dispatch entirely.
     */
    const doc = docOf([region("r1")]);
    const state = EditorState.create({ schema: promptSchema, doc });
    expect(reconcileTransaction(doc, state.tr, [region("r1")])).toBeNull();
  });

  it("moves a block that was reordered instead of copying it", () => {
    /*
     * A deletion can be followed by an append of the same target, which reorders the request
     * (`a b c` → `a c b`). Inserting a second copy of `b` and leaving the first in place gave the
     * document two nodes per requested block — and the next read walked off the end of the
     * request, because a block is inserted *before* its anchor. A reorder is one block moved
     * (found.md F-121).
     */
    const after = apply(docOf([region("a"), region("b"), region("c")]), [
      region("a"),
      region("c"),
      region("b"),
    ]);
    expect(blocksOf(after).map((block) => block.target.id)).toEqual(["a", "c", "b"]);
    // No duplicates: the size matches one block per requested target.
    expect(blocksOf(after).length).toBe(3);
  });

  it("handles a reversal, where every block but the first has to move", () => {
    const after = apply(docOf([region("a"), region("b"), region("c"), region("d")]), [
      region("d"),
      region("c"),
      region("b"),
      region("a"),
    ]);
    expect(blocksOf(after).map((block) => block.target.id)).toEqual(["d", "c", "b", "a"]);
    expect(blocksOf(after).length).toBe(4);
  });

  it("keeps the words when a block between them is deleted", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      promptSchema.nodes["paragraph"]!.create(null, [
        promptSchema.text("keep "),
        promptSchema.nodes["block"]!.create({ kind: "annotation", id: "r1", shape: "region" }),
        promptSchema.text(" this"),
      ]),
    ]);
    const after = apply(doc, []);
    expect(textOnlyOf(after).replace(/\s+/g, " ").trim()).toBe("keep this");
  });

  it("puts an appended block on a line of its own", () => {
    /*
     * A reference is a block, not a word. Its own line is what makes "delete this block"
     * unambiguous — the same rule the old string-based box expressed with a newline.
     */
    const after = apply(docWithText("move it left"), [capture("c1")]);
    expect(plainTextOf(after)).toBe("move it left\nCapture 1");
  });

  it("reuses a trailing empty paragraph instead of stacking a blank line", () => {
    /*
     * The editor always keeps one paragraph. Appending after it would leave an empty line under
     * every reference, and the box would drift downwards by one line per added block.
     */
    const after = apply(docWithText(""), [capture("c1"), capture("c2")]);
    expect(plainTextOf(after)).toBe("Capture 1\nCapture 2");
  });

  it("deletes a block and its line together, leaving no blank line behind", () => {
    /*
     * The keyboard and the mouse must agree. Left to the editor's default handling, Backspace
     * removes the atom and keeps the paragraph, so every deletion grew the box by an empty line
     * (found.md F-118).
     */
    const before = apply(docWithText(""), [capture("c1"), capture("c2")]);
    const after = apply(before, [capture("c2")]);
    expect(plainTextOf(after)).toBe("Capture 1");
    expect(after.childCount).toBe(1);
  });
});

describe("the delivered text", () => {
  /** A document with the given paragraphs' text (empty string = blank paragraph). */
  function docWithLines(lines: readonly string[]): PMNode {
    return promptSchema.nodes["doc"]!.create(
      null,
      lines.map((line) =>
        promptSchema.nodes["paragraph"]!.create(
          null,
          line === "" ? undefined : promptSchema.text(line),
        ),
      ),
    );
  }

  it("trims trailing spaces, which are invisible and only accumulate", () => {
    expect(plainTextOf(docWithLines(["hello   "]))).toBe("hello");
  });

  it("collapses runs of blank lines", () => {
    // Five empty lines between two sentences is noise, not formatting, to a model reader.
    expect(plainTextOf(docWithLines(["a", "", "", "", "", "b"]))).toBe("a\n\nb");
  });

  it("never ends with a newline", () => {
    expect(plainTextOf(docWithLines(["text", ""]))).toBe("text");
  });

  it("keeps a blank line between two paragraphs of real text", () => {
    expect(plainTextOf(docWithLines(["one", "", "two"]))).toBe("one\n\ntwo");
  });

  it("puts a block on its own line, which is how the request reads", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      promptSchema.nodes["paragraph"]!.create(null, promptSchema.text("move it")),
      promptSchema.nodes["paragraph"]!.create(
        null,
        promptSchema.nodes["block"]!.create({ kind: "capture", id: "c", shape: null }),
      ),
    ]);
    expect(plainTextOf(doc)).toBe("move it\nCapture 1");
  });

  it("is empty for a document that holds nothing", () => {
    expect(plainTextOf(docWithLines([""]))).toBe("");
    expect(plainTextOf(docOf([]))).toBe("");
  });
});

describe("the caret", () => {
  it("stays where it was when a block is deleted elsewhere", () => {
    /*
     * The reported bug, as a test: a caret at the end of the text must not move because a
     * block before it went away. This is ProseMirror's position mapping doing the work — the
     * document changes by one node, so the selection shifts by one node, not by a rewrite.
     */
    const withBlock = promptSchema.nodes["doc"]!.create(null, [
      promptSchema.nodes["paragraph"]!.create(null, [
        promptSchema.nodes["block"]!.create({ kind: "capture", id: "c1", shape: null }),
      ]),
      promptSchema.nodes["paragraph"]!.create(null, promptSchema.text("tail")),
    ]);

    let state = EditorState.create({ schema: promptSchema, doc: withBlock });
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)));

    const before = state.selection.from;
    // Reconcile through the real path, so the selection is mapped by the transaction itself.
    const tr = reconcileTransaction(state.doc, state.tr, []);
    if (!tr) throw new Error("the block should have been removed");
    const next = state.apply(tr);

    // The words survive, and the caret is still in `tail` rather than thrown to the start.
    expect(textOnlyOf(next.doc)).toContain("tail");
    expect(next.selection.from).toBeLessThanOrEqual(before);
    expect(next.selection.from).toBeGreaterThan(1);
  });
});
