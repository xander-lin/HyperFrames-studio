/**
 * @vitest-environment jsdom
 *
 * A chip's **red state** follows the store, not the document.
 *
 * ## The defect this pins
 *
 * Undoing a drawing does not edit the prompt: the block stays, and only its `withdrawn` flag
 * changes in the store. But ProseMirror calls `NodeView.update` only when a transaction changes
 * the node it draws, so nothing repainted — the mark was correctly withdrawn and the block
 * stayed black. To the user that reads as "the undo did nothing at all"
 * (found.md F-121).
 *
 * These tests drive a real `EditorView` in jsdom: the failure lives in the editor's update
 * pipeline, so a test of `paint` alone could not have caught it.
 */

import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { blockNodeView, repaintBlocks, type BlockState } from "./promptNodeView.js";
import { documentFor, type BlockTarget } from "./promptSchema.js";

const capture = (id: string): BlockTarget => ({ kind: "capture", id });
const region = (id: string): BlockTarget => ({ kind: "annotation", id, shape: "region" });

interface Mounted {
  readonly view: EditorView;
  readonly host: HTMLElement;
  readonly chips: () => HTMLElement[];
}

function mount(targets: readonly BlockTarget[], states: Map<string, BlockState>): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: documentFor(targets),
      plugins: [
        // The NodeView reads the store through the same lazy lookup the component passes.
      ],
    }),
    nodeViews: { block: blockNodeView(() => states) },
  });
  return {
    view,
    host,
    chips: () => Array.from(host.querySelectorAll<HTMLElement>("[data-mystudio-ref]")),
  };
}

describe("a chip with no store state", () => {
  it("renders its label and is not red", () => {
    const mounted = mount([capture("c1")], new Map());
    const chip = mounted.chips()[0];
    expect(chip?.textContent).toBe("Capture 1");
    expect(chip?.getAttribute("data-mystudio-withdrawn")).toBe("false");
    expect(chip?.classList.contains("ms-ref-withdrawn")).toBe(false);
    mounted.view.destroy();
  });
});

describe("repaintBlocks", () => {
  it("turns a chip red when its mark is withdrawn", () => {
    /*
     * The reported bug, exactly: the store changes and nothing else does. Without the explicit
     * repaint the chip stays black, because an unchanged node gives the editor nothing to
     * update.
     */
    const states = new Map<string, BlockState>([["capture:c1", { withdrawn: false }]]);
    const mounted = mount([capture("c1")], states);
    expect(mounted.chips()[0]?.getAttribute("data-mystudio-withdrawn")).toBe("false");

    // The drawing is undone: the store says so, the document is untouched.
    states.set("capture:c1", { withdrawn: true });
    repaintBlocks(mounted.view, () => states);

    const chip = mounted.chips()[0];
    expect(chip?.getAttribute("data-mystudio-withdrawn")).toBe("true");
    expect(chip?.classList.contains("ms-ref-withdrawn")).toBe(true);
    // The text stays: the block is still in the request, it just names a mark that is gone.
    expect(chip?.textContent).toBe("Capture 1");
    mounted.view.destroy();
  });

  it("restores the normal look when the mark comes back", () => {
    const states = new Map<string, BlockState>([["capture:c1", { withdrawn: true }]]);
    const mounted = mount([capture("c1")], states);
    expect(mounted.chips()[0]?.classList.contains("ms-ref-withdrawn")).toBe(true);

    states.set("capture:c1", { withdrawn: false });
    repaintBlocks(mounted.view, () => states);

    expect(mounted.chips()[0]?.classList.contains("ms-ref-withdrawn")).toBe(false);
    mounted.view.destroy();
  });

  it("renumbers labels from the document, not from the DOM", () => {
    /*
     * A deletion renumbers every later block while their nodes stay identical, so the editor
     * does not redraw them. The repaint has to take the number from the document's positions or
     * the chips keep naming numbers that no longer exist.
     */
    const states = new Map<string, BlockState>();
    const mounted = mount([capture("c1"), region("r2")], states);
    expect(mounted.chips().map((chip) => chip.textContent)).toEqual(["Capture 1", "Region 2"]);

    // Delete `Capture 1` from the document directly and repaint.
    const first = mounted.view.state.doc.child(0);
    mounted.view.dispatch(mounted.view.state.tr.delete(0, first.nodeSize));
    repaintBlocks(mounted.view, () => states);

    expect(mounted.chips().map((chip) => chip.textContent)).toEqual(["Region 1"]);
    mounted.view.destroy();
  });
});
