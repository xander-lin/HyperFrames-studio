/**
 * The prompt's document model.
 *
 * ## Why a real document, and not "a string plus a rebuild"
 *
 * The prompt is one document the user types into, and part of it is not text: `Capture 2`
 * names something that will be delivered, deletes as a unit, and turns red when the mark
 * behind it is undone.
 *
 * The previous implementation kept **two representations** of that one document — a plain
 * string (what got delivered) and a segment tree rebuilt into a `contenteditable` on every
 * change. Every defect in this box came from the seam between them:
 *
 * - **A chip silently became plain text.** The DOM was rebuilt by parsing the string and
 *   asking "is this line a block?", so any numbering drift dropped the block's identity and
 *   left the words behind (found.md F-108).
 * - **Deleting a block threw the caret to the front.** Deleting rewrote the string, which
 *   forced a full DOM rebuild, which destroyed the node the caret lived in (found.md F-116,
 *   F-117). Two rounds of "remember the caret better" only moved the symptom.
 *
 * Here the document **is** the tree. "It is a block" is a node type, not a conclusion drawn
 * from text, so a chip cannot degrade into a sentence. Deleting one is a transaction, and the
 * selection is mapped by the editor (found.md F-118).
 *
 * ## Why the number is not stored on the block
 *
 * A block's number is its **position in the request** — `Element 1` → `Capture 2` →
 * `Capture 3`, renumbered when one is deleted. Storing the number on the node would mean
 * rewriting every later node on every deletion, and rewriting the document is exactly what
 * used to move the caret.
 *
 * So a block node stores **what it points at**, and the number is read off its position at
 * render time. Deleting a block is a single deletion: nothing else in the document changes.
 */

import { Fragment, Schema, type Node as PMNode } from "prosemirror-model";

/**
 * What a block node points at. One per store the delivery draws from.
 *
 * `drawing` is the whiteboard's: a sketch is a block the user can see, name and delete, but
 * it is **not** a moment of the video, so it must not be called `Capture N` — that name would
 * claim there is footage behind it (found.md F-128).
 */
export type BlockKind = "annotation" | "element" | "capture" | "drawing";

/** A shape kind, for the label. A region and an arrow must not read the same. */
export type BlockShape = "region" | "arrow" | "freehand";

/** A block as the document sees it: what it points at, not what it says. */
export interface BlockTarget {
  readonly kind: BlockKind;
  /** Stable identity in its own store (annotation id, element key, capture key). */
  readonly id: string;
  /** For annotation blocks: which shape, so the label reads `Arrow 2`. */
  readonly shape?: BlockShape;
}

/** A key that identifies one target across store updates and re-renders. */
export function targetKey(target: Pick<BlockTarget, "kind" | "id">): string {
  return `${target.kind}:${target.id}`;
}

/** Whether a value is one of the block kinds. Narrows without asserting. */
function isBlockKind(value: unknown): value is BlockKind {
  return (
    value === "annotation" || value === "element" || value === "capture" || value === "drawing"
  );
}

/** Whether a value is one of the shape kinds. */
function isBlockShape(value: unknown): value is BlockShape {
  return value === "region" || value === "arrow" || value === "freehand";
}

/**
 * The label a block shows at a given position in the request.
 *
 * One function, one sequence: every kind draws from the same counter, so the request reads
 * `Element 1`, `Capture 2`, `Capture 3`. Per-kind counters produced two blocks both called
 * `1`, which made the number useless as a reference (found.md F-107).
 */
export function labelForTarget(target: BlockTarget, ordinal: number): string {
  if (target.kind === "drawing") return `Drawing ${ordinal}`;
  if (target.kind === "capture") return `Capture ${ordinal}`;
  if (target.kind === "element") return `Element ${ordinal}`;
  return `${target.shape === "arrow" ? "Arrow" : "Region"} ${ordinal}`;
}

/**
 * The schema.
 *
 * A block is an **inline atom** in a paragraph, not a block-level node: the user writes
 * "move Arrow 1 left", and `Arrow 1` has to sit inside that sentence. Making it own a line
 * would force the sentence into several lines just to name one mark.
 *
 * `atom: true` is what gives it the behaviour the old DOM had to emulate: the editor treats
 * it as one object, so one Backspace removes it and the caret steps over it rather than
 * through it.
 *
 * The node has **no text content**. What it displays comes from a decoration, so renumbering
 * is a redraw. That is the point: the document never changes just because numbers moved.
 *
 * There is deliberately no `parseDOM`: nothing loads HTML into this schema. Pasting is
 * handled as plain text, which is also the only honest reading — a block reference is not
 * something that can be pasted back into existence.
 */
export const promptSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    block: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: true,
      attrs: {
        kind: {},
        id: {},
        shape: { default: null },
      },
      /*
       * The DOM carries the identity, not the label. Runtime checks and the selection guard
       * keep looking for `data-mystudio-ref`, so the external contract is unchanged.
       */
      toDOM: (node) => [
        "span",
        {
          class: "ms-ref",
          "data-mystudio-ref": "",
          "data-mystudio-block": String(node.attrs["kind"]),
          "data-mystudio-id": String(node.attrs["id"]),
          "data-mystudio-selectable": "",
        },
      ],
    },
  },
});

/** The block node type, resolved once. */
const blockType = promptSchema.nodes["block"];
const paragraphType = promptSchema.nodes["paragraph"];
if (!blockType || !paragraphType) {
  throw new Error("The prompt schema is missing its block or paragraph node");
}

/** One block found in a document, with the position it occupies and its number. */
export interface PlacedBlock {
  readonly target: BlockTarget;
  /** Document position of the node, for decorations and selection. */
  readonly pos: number;
  /** 1-based position in the request. */
  readonly ordinal: number;
  readonly label: string;
}

/** Read a block node's target, or `null` when the node is something else. */
function targetOf(node: PMNode): BlockTarget | null {
  if (node.type.name !== "block") return null;
  const kind = node.attrs["kind"];
  const id = node.attrs["id"];
  const shape = node.attrs["shape"];
  if (!isBlockKind(kind) || typeof id !== "string") return null;
  return { kind, id, ...(isBlockShape(shape) ? { shape } : {}) };
}

/** Build the inline block node for a target. */
export function blockNode(target: BlockTarget): PMNode {
  return blockType.create({
    kind: target.kind,
    id: target.id,
    shape: target.shape ?? null,
  });
}

/** A paragraph holding exactly one block, which is how "add to prompt" appends. */
export function blockParagraph(target: BlockTarget): PMNode {
  return paragraphType.create(null, blockNode(target));
}

/** A document holding one paragraph per target. */
export function documentFor(targets: readonly BlockTarget[]): PMNode {
  const paragraphs = targets.map(blockParagraph);
  return promptSchema.nodes["doc"]!.create(null, Fragment.fromArray(paragraphs));
}

/**
 * Every block in the document, in reading order, numbered from 1.
 *
 * Reading order **is** request order: the box shows the blocks where the user sees them, and
 * the number is that position. That is why deleting a block renumbers the rest without
 * touching the document.
 */
export function blocksOf(doc: PMNode): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  doc.descendants((node, pos) => {
    const target = targetOf(node);
    if (!target) return true;
    const ordinal = blocks.length + 1;
    blocks.push({ target, pos, ordinal, label: labelForTarget(target, ordinal) });
    return false;
  });
  return blocks;
}

/**
 * The number a block at `pos` carries right now.
 *
 * Counted from the document itself rather than remembered, because that is the definition: a
 * number is a position. Anything that inserts or deletes a block before `pos` changes this
 * answer without any text being written (found.md F-118).
 */
export function ordinalAt(doc: PMNode, pos: number): number {
  let ordinal = 0;
  let found = 0;
  doc.descendants((node, at) => {
    if (node.type.name !== "block") return true;
    ordinal += 1;
    if (at === pos) {
      found = ordinal;
      return false;
    }
    return true;
  });
  return found === 0 ? ordinal : found;
}

/**
 * The label a block at `pos` shows.
 *
 * The fallback matters: a node that has just been created is not in a document yet, so it has
 * no position to count from. Rendering it as "the last one" is right for the only case that
 * happens — a block appended to the end of the request.
 */
export function labelForPosition(
  doc: PMNode,
  pos: number | null,
  target: BlockTarget,
): string {
  const ordinal = pos === null ? 0 : ordinalAt(doc, pos);
  return labelForTarget(target, ordinal === 0 ? blocksOf(doc).length + 1 : ordinal);
}

/**
 * The document's content, rendered node by node.
 *
 * Paragraphs contribute their own line, so a block added at the end starts on a fresh line
 * and a sentence stays one paragraph. `labels` supplies what each block currently reads;
 * the stored node has no text of its own.
 */
function renderNode(node: PMNode, pos: number, labels: ReadonlyMap<number, string>): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "block") return labels.get(pos) ?? "";
  if (node.isLeaf) return "";

  let out = "";
  let offset = 0;
  node.forEach((child) => {
    out += renderNode(child, pos + 1 + offset, labels);
    offset += child.nodeSize;
  });
  return out;
}

/**
 * The document as plain text — what gets delivered.
 *
 * Labels are substituted **here**, at the boundary, from the same positions the box renders,
 * so the text and the chips cannot disagree: they are two readings of one tree.
 *
 * The trailing blank lines and runs of blank lines are collapsed: the prompt is read by a
 * model, and five empty lines between two sentences is noise rather than formatting.
 */
export function plainTextOf(doc: PMNode): string {
  const labels = new Map<number, string>();
  for (const block of blocksOf(doc)) labels.set(block.pos, block.label);

  const lines: string[] = [];
  let offset = 0;
  doc.forEach((paragraph) => {
    // `offset` is the paragraph's own document position; its content starts one after.
    lines.push(renderNode(paragraph, offset, labels));
    offset += paragraph.nodeSize;
  });

  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "")
    .replace(/^\n+/, "");
}

/**
 * The document's text only, without block labels.
 *
 * Used to answer "is there anything here" and by tests: a document made of block nodes has no
 * text at all, which is exactly the difference between "empty" and "nothing written yet".
 */
export function textOnlyOf(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n", " ");
}

/** Whether the document holds nothing the user would recognise as content. */
export function isEmptyDoc(doc: PMNode): boolean {
  return blocksOf(doc).length === 0 && textOnlyOf(doc).trim() === "";
}
