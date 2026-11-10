import { describe, expect, it } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { removeBlockCommand, removeBlockAt } from "./promptBlockKeys.js";
import { blocksOf, blockParagraph, promptSchema, type BlockTarget } from "./promptSchema.js";

/**
 * Deleting a block with the keyboard, and **not** deleting anything else.
 *
 * ## Why this file exists
 *
 * The block-deletion command runs **before** the editor's own Backspace. That makes it
 * dangerous: if it claims a keystroke and then fails, the user loses Backspace in the whole
 * field. Two ways it did exactly that (found.md F-121):
 *
 * - reading a child at index `-1` when the caret was nowhere near a block — which **threw** out
 *   of the key handler, so Backspace was dead in the middle of an ordinary sentence;
 * - reporting a position when the document would not change, consuming the key for nothing.
 *
 * So the properties here are about refusal as much as about deletion: the command must decline
 * whenever a plain Backspace is the right answer.
 */

const capture = (id: string): BlockTarget => ({ kind: "capture", id });

/** A document with one paragraph holding `text`. */
function textDoc(text: string) {
  return promptSchema.nodes["doc"]!.create(null, [
    promptSchema.nodes["paragraph"]!.create(null, text === "" ? undefined : promptSchema.text(text)),
  ]);
}

/** A state with the caret at an absolute document position. */
function caretAt(doc: EditorState["doc"], pos: number): EditorState {
  const state = EditorState.create({ schema: promptSchema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
}

describe("the block-deletion command declines when it should", () => {
  it("does not claim Backspace in the middle of a sentence", () => {
    /*
     * The exact crash: the caret at offset 5 of "move this" is not at any block's edge, so the
     * command must return false and let the text deletion happen. Returning true here is what
     * threw (`Index -1 out of range`).
     */
    const doc = textDoc("move this");
    const state = caretAt(doc, 5);
    expect(() => removeBlockCommand("backward")(state, () => undefined)).not.toThrow();
    expect(removeBlockCommand("backward")(state, () => undefined)).toBe(false);
  });

  it("does not claim Backspace at the start of a paragraph with no block before it", () => {
    const state = caretAt(textDoc("hello"), 1);
    expect(removeBlockCommand("backward")(state, () => undefined)).toBe(false);
  });

  it("does not claim Delete at the end of a paragraph with no block after it", () => {
    const doc = textDoc("hello");
    const state = caretAt(doc, doc.content.size - 1);
    expect(removeBlockCommand("forward")(state, () => undefined)).toBe(false);
  });

  it("does not claim Backspace in an empty document", () => {
    const state = caretAt(textDoc(""), 1);
    expect(removeBlockCommand("backward")(state, () => undefined)).toBe(false);
  });
});

describe("the block-deletion command deletes when it should", () => {
  /** Apply the command and return the resulting document's block labels. */
  function run(doc: EditorState["doc"], pos: number, direction: "backward" | "forward") {
    const state = caretAt(doc, pos);
    const command = removeBlockCommand(direction);
    let next = state;
    const handled = command(state, (tr) => {
      next = state.apply(tr);
    });
    return { handled, labels: blocksOf(next.doc).map((block) => block.label) };
  }

  it("removes the block and its line with Backspace right after it", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [blockParagraph(capture("c1"))]);
    // Caret just after the atom: `1` (paragraph start) + 1 (atom) = position 2.
    const result = run(doc, 2, "backward");
    expect(result.handled).toBe(true);
    expect(result.labels).toEqual([]);
  });

  it("removes the block with Delete right before it", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [blockParagraph(capture("c1"))]);
    const result = run(doc, 1, "forward");
    expect(result.handled).toBe(true);
    expect(result.labels).toEqual([]);
  });

  it("removes the middle block of three, leaving the others renumbered", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      blockParagraph(capture("c1")),
      blockParagraph(capture("c2")),
      blockParagraph(capture("c3")),
    ]);
    // Paragraphs are 3 wide, so `c2`'s atom sits at 4; just after it is 5.
    const result = run(doc, 5, "backward");
    expect(result.handled).toBe(true);
    expect(result.labels).toEqual(["Capture 1", "Capture 2"]);
  });

  it("keeps the sentence when the block sits inside it", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      promptSchema.nodes["paragraph"]!.create(null, [
        promptSchema.text("keep "),
        promptSchema.nodes["block"]!.create({ kind: "capture", id: "c1", shape: null }),
        promptSchema.text(" this"),
      ]),
    ]);
    // "keep " is 5, the block is one, so the position just before the atom is 6.
    const state = caretAt(doc, 6);
    let next = state;
    const handled = removeBlockCommand("forward")(state, (tr) => {
      next = state.apply(tr);
    });
    expect(handled).toBe(true);
    expect(next.doc.textContent.replace(/\s+/g, " ").trim()).toBe("keep this");
  });
});

describe("a NodeSelection on the block, which is what clicking a chip gives", () => {
  it("deletes it with either key", () => {
    for (const direction of ["backward", "forward"] as const) {
      const doc = promptSchema.nodes["doc"]!.create(null, [blockParagraph(capture("c1"))]);
      const state = EditorState.create({ schema: promptSchema, doc }).apply(
        EditorState.create({ schema: promptSchema, doc }).tr.setSelection(
          NodeSelection.create(doc, 1),
        ),
      );
      // The selection really is a NodeSelection on the atom, not a text caret.
      expect(state.selection).toBeInstanceOf(NodeSelection);

      let next = state;
      const handled = removeBlockCommand(direction)(state, (tr) => {
        next = state.apply(tr);
      });
      expect(handled).toBe(true);
      expect(blocksOf(next.doc)).toHaveLength(0);
    }
  });
});

describe("removeBlockAt", () => {
  it("keeps the paragraph when it also holds text", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      promptSchema.nodes["paragraph"]!.create(null, [
        promptSchema.text("a"),
        promptSchema.nodes["block"]!.create({ kind: "capture", id: "c1", shape: null }),
      ]),
    ]);
    const state = EditorState.create({ schema: promptSchema, doc });
    const tr = state.tr;
    removeBlockAt(tr, 2);
    expect(tr.doc.textContent).toBe("a");
  });

  it("removes the whole paragraph when the block is alone on it", () => {
    const doc = promptSchema.nodes["doc"]!.create(null, [
      blockParagraph(capture("c1")),
      blockParagraph(capture("c2")),
    ]);
    const state = EditorState.create({ schema: promptSchema, doc });
    const tr = state.tr;
    removeBlockAt(tr, 1);
    expect(blocksOf(tr.doc).map((block) => block.target.id)).toEqual(["c2"]);
    // The paragraph went too, so there is no empty line left behind.
    expect(tr.doc.childCount).toBe(1);
  });
});
