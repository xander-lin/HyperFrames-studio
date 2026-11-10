/**
 * How a block looks, and how it keeps looking right.
 *
 * ## The label is rendered, never stored
 *
 * A block's number is its position in the request, so adding or deleting **any** block
 * changes it. If the number lived in the document, every such change would rewrite text — the
 * operation that destroyed the caret (found.md F-116).
 *
 * So the node stores only what it points at. The visible `Capture 2` is produced here, from
 * wherever the node currently sits. Renumbering is a repaint of an unchanged document.
 *
 * This is also why a chip cannot degrade into plain text: there is no path from "a node" to
 * "some characters". Either the node is in the tree or it is not (found.md F-108, F-118).
 *
 * ## Why a NodeView and not a decoration
 *
 * The label has to be **real text in the DOM**: it is what the user reads and selects, and
 * what an accessibility tool announces. A CSS pseudo-element would look identical and be
 * invisible to all three.
 *
 * A NodeView is safe here only because the node is an `atom`: the editor never reads this DOM
 * back into the document, so the label text inside cannot become document content. That
 * guarantee is the entire difference from the old implementation, where the label *was*
 * document content and had to be re-derived from text on every change.
 */

import { type Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { blocksOf, labelForPosition, targetKey, type BlockTarget } from "./promptSchema.js";

/** What the store says about one block, beyond what the document knows. */
export interface BlockState {
  /** The mark behind this block was undone: paint it red and strike it out. */
  readonly withdrawn: boolean;
}

/** Where a view reads the live per-block state. */
export type BlockStateLookup = () => ReadonlyMap<string, BlockState>;

/** The target a block node points at. */
export function targetOfNode(node: PMNode): BlockTarget {
  const kind = node.attrs["kind"];
  const shape = node.attrs["shape"];
  return {
    kind: kind as BlockTarget["kind"],
    id: String(node.attrs["id"]),
    ...(shape === "region" || shape === "arrow" || shape === "freehand"
      ? { shape }
      : {}),
  };
}

/**
 * Paint one chip.
 *
 * The **only** function that decides how a block looks. It takes a target rather than a node so
 * the same code serves a live NodeView and the explicit repaint below; two painters for one
 * appearance is how a chip ends up looking different depending on how it was last touched.
 */
function paint(
  element: HTMLElement,
  target: BlockTarget,
  pos: number | null,
  doc: PMNode,
  withdrawn: boolean,
): void {
  const label = labelForPosition(doc, pos, target);
  if (element.textContent !== label) element.textContent = label;
  element.setAttribute("data-mystudio-ref", label);
  element.setAttribute("data-mystudio-withdrawn", withdrawn ? "true" : "false");
  element.classList.toggle("ms-ref-withdrawn", withdrawn);
  element.title = withdrawn
    ? `${label} was undone — the mark is no longer on the frame`
    : label;
}

/**
 * Repaint every chip from the current document and store state.
 *
 * ## Why this is needed at all
 *
 * A chip's red state lives in the **store**, not in the document: undoing a drawing does not
 * edit the prompt. But ProseMirror only calls `NodeView.update` when a transaction actually
 * changes the node it draws, so changing the withdrawn map alone repainted nothing — the mark
 * was correctly withdrawn and the block stayed black, which reads as "the undo did not work"
 * (found.md F-121).
 *
 * The atoms carry their identity in the DOM, which is enough to look each one up: the document
 * supplies the number, the store supplies the red state, and `paint` does the rest.
 */
export function repaintBlocks(view: EditorView, lookup: BlockStateLookup): void {
  const placed = blocksOf(view.state.doc);
  const byKey = new Map(placed.map((block) => [targetKey(block.target), block]));
  const states = lookup();

  for (const element of Array.from(view.dom.querySelectorAll<HTMLElement>("[data-mystudio-ref]"))) {
    const kind = element.getAttribute("data-mystudio-block");
    const id = element.getAttribute("data-mystudio-id");
    if (kind === null || id === null) continue;
    const listed: BlockTarget = { kind: kind as BlockTarget["kind"], id };
    const block = byKey.get(targetKey(listed));
    /*
     * The document is the authority on which shape a block is — the DOM only carries the id.
     * A block that is no longer in the document is skipped: its element is on its way out.
     */
    if (!block) continue;
    paint(
      element,
      block.target,
      block.pos,
      view.state.doc,
      states.get(targetKey(block.target))?.withdrawn === true,
    );
  }
}

/**
 * The NodeView constructor.
 *
 * `update` gets the same DOM element plus the new node, so an insert or delete repaints in
 * place. Nothing is torn down — which is what keeps the caret: the element it stands next to is
 * never the element being replaced.
 */
export function blockNodeView(lookup: BlockStateLookup): NodeViewConstructor {
  return (node, view, getPos): NodeView => {
    const element = document.createElement("span");
    element.className = "ms-ref";
    element.setAttribute("data-mystudio-ref", "");
    element.setAttribute("data-mystudio-selectable", "");
    element.setAttribute("data-mystudio-block", String(node.attrs["kind"]));
    element.setAttribute("data-mystudio-id", String(node.attrs["id"]));

    /*
     * `getPos` is optional in the signature but is always supplied for a node in a document.
     * Treating "absent" as "no position yet" keeps this honest instead of guessing: the paint
     * then falls back to the length of the block list, which is where an appended block goes.
     */
    const positionOf = (): number | null => {
      try {
        return getPos?.() ?? null;
      } catch {
        // The view is mid-teardown and the node is no longer reachable.
        return null;
      }
    };

    const draw = (target: BlockTarget): void => {
      paint(
        element,
        target,
        positionOf(),
        view.state.doc,
        lookup().get(targetKey(target))?.withdrawn === true,
      );
    };

    draw(targetOfNode(node));

    return {
      dom: element,
      // An atom draws itself; it has no content for the editor to render.
      contentDOM: undefined,
      update: (next) => {
        if (next.type !== node.type) return false;
        draw(targetOfNode(next));
        return true;
      },
      ignoreMutation: () => true,
    };
  };
}
