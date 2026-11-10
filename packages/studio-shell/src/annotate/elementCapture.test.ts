import { describe, expect, it } from "vitest";
import { toElementTarget, type SelectionLike } from "./elementCapture.js";
import { labelForTarget } from "./promptSchema.js";

/**
 * Studio's selection → a request target.
 *
 * The conversion is the seam between two worlds: a live `DomEditSelection` with a real
 * element, and the pure request format. What matters is that nothing needed to locate
 * the element later is lost on the way, and that absent fields stay absent rather than
 * becoming the string `"undefined"`.
 */

const selection: SelectionLike = {
  tagName: "ul",
  label: "Lines",
  id: "lines",
  hfId: "hf-abc",
  selector: ".lines",
  selectorIndex: 1,
  sourceFile: "compositions/cover.html",
  boundingBox: { x: 120, y: 240, width: 400, height: 200 },
  textContent: "二叉搜索树的插入会让树长歪",
};

describe("toElementTarget", () => {
  it("keeps everything needed to find the element again", () => {
    const target = toElementTarget(selection);
    expect(target.selector).toBe(".lines");
    expect(target.selectorIndex).toBe(1);
    expect(target.sourceFile).toBe("compositions/cover.html");
    expect(target.tagName).toBe("ul");
  });

  it("prefers data-hf-id over a plain id, because it survives reflow", () => {
    const target = toElementTarget({
      tagName: "div",
      id: "temporary",
      dataAttributes: { "data-hf-id": "hf-xyz" },
    });
    expect(target.hfId).toBe("hf-xyz");
    expect(target.id).toBe("temporary");
  });

  it("omits absent fields instead of writing 'undefined'", () => {
    // A request saying `selector: undefined` is worse than one that says nothing.
    const target = toElementTarget({ tagName: "p" });
    expect(target).not.toHaveProperty("selector");
    expect(target).not.toHaveProperty("id");
    expect(target).not.toHaveProperty("text");
    expect(target).not.toHaveProperty("box");
  });

  it("treats a blank string as absent", () => {
    const target = toElementTarget({ tagName: "p", selector: "   ", label: "" });
    expect(target).not.toHaveProperty("selector");
    expect(target).not.toHaveProperty("label");
  });

  it("keeps selector index zero, which is a real ordinal", () => {
    // `0` is falsy; dropping it would make the first match look unspecified.
    const target = toElementTarget({ tagName: "p", selectorIndex: 0 });
    expect(target.selectorIndex).toBe(0);
  });
});

describe("element blocks", () => {
  it("labels blocks by ordinal, matching the mark convention", () => {
    expect(labelForTarget({ kind: "element", id: "e" }, 1)).toBe("Element 1");
  });

  it("puts only the reference in the box, never the tag or selector", () => {
    /*
     * The box holds blocks, not specifications. Anything with a tag in it reads as prose
     * the user should edit — which is exactly what a block must not be.
     */
    expect(labelForTarget({ kind: "element", id: "e" }, 2)).toBe("Element 2");
  });
});
