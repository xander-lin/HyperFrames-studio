import { describe, expect, it } from "vitest";
import type { ElementTarget } from "@mystudio/protocol";
import { elementKey, hasElement } from "./targetKey.js";

/**
 * What counts as "the same element".
 *
 * ## Why this is worth its own tests
 *
 * Two defects have lived in this rule. The first: the prompt text gained an `Element 1` line per
 * press while the block list stayed at one, because the reference was appended **before** the
 * duplicate check (found.md F-103). The second: the identity was the block's **label**, so it
 * moved whenever anything before it was deleted (found.md F-108, F-118).
 *
 * The rule is imported here, not modelled: a copy of it in a test can silently disagree with the
 * product, which is exactly how a "fixed" duplicate comes back.
 */

const title: ElementTarget = { tagName: "h1", selector: ".title", hfId: "hf-1" };
const body: ElementTarget = { tagName: "p", selector: ".body", hfId: "hf-2" };

describe("element identity", () => {
  it("is the same for two records describing one element", () => {
    expect(elementKey({ ...title })).toBe(elementKey({ ...title }));
  });

  it("differs for different elements", () => {
    expect(elementKey(title)).not.toBe(elementKey(body));
  });

  it("separates two nodes matched by one selector, by index", () => {
    const first: ElementTarget = { tagName: "li", selector: "li", selectorIndex: 0 };
    const second: ElementTarget = { tagName: "li", selector: "li", selectorIndex: 1 };
    expect(elementKey(first)).not.toBe(elementKey(second));
  });

  it("treats an unspecified index as the same as index 0", () => {
    /*
     * `0` is falsy, so a missing index and "the first match" used to compare unequal — which
     * would have let the same node in twice.
     */
    const unspecified: ElementTarget = { tagName: "p", selector: ".body" };
    const zero: ElementTarget = { tagName: "p", selector: ".body", selectorIndex: 0 };
    expect(elementKey(unspecified)).toBe(elementKey(zero));
  });

  it("treats two elements with no identifying fields as the same", () => {
    // Degenerate but defined: with nothing to tell them apart, they are one thing.
    expect(elementKey({ tagName: "p" })).toBe(elementKey({ tagName: "p" }));
  });

  it("is stable when the block's label moves", () => {
    /*
     * The identity must not depend on the label: deleting a block before this one renumbers it
     * from `Element 2` to `Element 1`, and it has to stay the same element.
     */
    const before = elementKey(title);
    const after = elementKey({ ...title });
    expect(after).toBe(before);
  });
});

describe("hasElement", () => {
  it("is false for an empty request", () => {
    expect(hasElement([], title)).toBe(false);
  });

  it("is true when the element is already in the request", () => {
    expect(hasElement([{ target: title }], title)).toBe(true);
  });

  it("is false for a different element", () => {
    expect(hasElement([{ target: title }], body)).toBe(false);
  });

  it("recognises the same element described by a different object", () => {
    // The reported defect: pressing add twice must not create a second block.
    expect(hasElement([{ target: { ...title } }], title)).toBe(true);
  });
});
