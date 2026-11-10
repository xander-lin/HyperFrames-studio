import { describe, expect, it } from "vitest";
import { appendAnnotationRef } from "@mystudio/protocol";
import { toElementTarget } from "./elementCapture.js";
import { labelForTarget } from "./promptSchema.js";

/**
 * Pressing `S` on a selected element.
 *
 * The requirement that started this: Studio could already build a prompt from a selected
 * element, but only by copying it by hand. The annotation window now does the same thing
 * with the same key, and the two paths must produce **the same request** — so the parts
 * that decide what goes in the box are pinned here.
 *
 * What the box must *not* get: the tag, the selector, the source file, a screenshot.
 * Those are machine details, and the box holds one thing only — a reference.
 */

describe("S on a selected element", () => {
  const selection = {
    tagName: "ul",
    label: "Lines",
    selector: ".lines",
    sourceFile: "compositions/cover.html",
    boundingBox: { x: 10, y: 20, width: 30, height: 40 },
    textContent: "some text",
  };

  it("adds exactly one block line, on its own line", () => {
    const ordinal = 1;
    const text = appendAnnotationRef("", labelForTarget({ kind: "element", id: "e" }, ordinal));
    expect(text).toBe("Element 1");
  });

  it("appends below what the user already wrote instead of replacing it", () => {
    // `S` is pressed repeatedly while writing; replacing would eat the sentence.
    const text = appendAnnotationRef("make this list shorter", labelForTarget({ kind: "element", id: "e" }, 1));
    expect(text).toBe("make this list shorter\nElement 1");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("keeps the box free of machine details", () => {
    const text = appendAnnotationRef("", labelForTarget({ kind: "element", id: "e" }, 1));
    for (const detail of ["<ul>", ".lines", "cover.html", "x=", ".png"]) {
      expect(text).not.toContain(detail);
    }
  });

  it("numbers blocks continuously with the marks already in the prompt", () => {
    /*
     * Block numbers are one sequence across both kinds. If elements started again at 1,
     * a prompt with `Region 1` and `Element 1` would name two different things with the
     * same label.
     */
    let text = appendAnnotationRef("", "Region 1");
    text = appendAnnotationRef(text, labelForTarget({ kind: "element", id: "e" }, 2));
    expect(text).toBe("Region 1\nElement 2");
  });

  it("still carries everything needed to locate the element, in the target", () => {
    // The box shows a label; the target goes on the wire. Both must survive the same
    // press, or the heading in the request names nothing.
    const target = toElementTarget(selection);
    expect(target.selector).toBe(".lines");
    expect(target.sourceFile).toBe("compositions/cover.html");
    expect(labelForTarget({ kind: "element", id: "e" }, 1)).toBe("Element 1");
  });
});
