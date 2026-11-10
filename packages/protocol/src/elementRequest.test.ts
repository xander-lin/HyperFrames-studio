import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationBundle, ArrowAnnotation } from "./annotation.js";
import { renderElementRequest } from "./elementRequest.js";
import { REQUEST_SCHEMA_VERSION, REQUEST_SECTIONS, REQUEST_TITLE, renderWhatToDo } from "./requestFormat.js";
import { renderUserPrompt } from "./prompt.js";

/**
 * One prompt format, two producers.
 *
 * Studio could already copy an agent prompt built from a selected element. This project
 * added a second one built from spatial annotations. Two formats for "change this thing"
 * means the reader has to learn two shapes and the writers drift apart silently.
 *
 * These tests pin the **shared envelope** rather than either body: title, version,
 * section names, guardrails. If one producer renames a section, the other must break a
 * test here rather than diverge quietly in the field.
 */

const arrow: ArrowAnnotation = {
  kind: "arrow",
  from: { x: 0.2, y: 0.3 },
  to: { x: 0.8, y: 0.7 },
};

function annotated(): Annotation {
  return {
    id: "a1",
    shape: arrow,
    frame: {
      compositionPath: "index.html",
      time: 12.5,
      compositionWidth: 1920,
      compositionHeight: 1080,
    },
    note: "",
    createdAt: 1,
  };
}

function bundle(): AnnotationBundle {
  return {
    schemaVersion: 1,
    projectDir: "/projects/demo",
    projectId: "demo",
    summary: "",
    annotations: [annotated()],
    createdAt: 1,
  };
}

const elementRequest = () =>
  renderElementRequest({
    projectDir: "/projects/demo",
    compositionPath: "compositions/cover.html",
    time: 12.5,
    target: {
      tagName: "ul",
      selector: ".lines",
      hfId: "hf-abc",
      label: "Lines",
      box: { x: 120, y: 240, width: 400, height: 200 },
      text: "二叉搜索树的插入会让树长歪",
      sourceFile: "compositions/cover.html",
    },
    instruction: "make the list shorter",
  });

describe("the shared envelope", () => {
  it("uses the same title and version in both producers", () => {
    for (const text of [renderUserPrompt(bundle(), "move it"), elementRequest()]) {
      expect(text).toContain(REQUEST_TITLE);
      expect(text).toContain(`Schema version: ${REQUEST_SCHEMA_VERSION}`);
    }
  });

  it("uses the same section names in both producers", () => {
    for (const text of [renderUserPrompt(bundle(), "move it"), elementRequest()]) {
      expect(text).toContain(REQUEST_SECTIONS.want);
      expect(text).toContain(REQUEST_SECTIONS.targets);
      expect(text).toContain(REQUEST_SECTIONS.whatToDo);
    }
  });

  it("shares the guardrails verbatim, so one producer cannot gain a rule alone", () => {
    const rule = "npx hyperframes lint";
    expect(renderUserPrompt(bundle(), "move it")).toContain(rule);
    expect(elementRequest()).toContain(rule);
    // And the block really is the shared one.
    expect(elementRequest()).toContain(renderWhatToDo());
  });

  it("puts the instruction before the details in both", () => {
    // A reader needs to know what is wanted before being told what things are.
    const annotatedText = renderUserPrompt(bundle(), "move it");
    expect(annotatedText.indexOf(REQUEST_SECTIONS.want)).toBeLessThan(
      annotatedText.indexOf(REQUEST_SECTIONS.targets),
    );

    const elementText = elementRequest();
    expect(elementText.indexOf(REQUEST_SECTIONS.want)).toBeLessThan(
      elementText.indexOf(REQUEST_SECTIONS.targets),
    );
  });

  it("passes the user's words through unedited", () => {
    // Rewording a request is inventing intent.
    const instruction = "  keep  the double spaces and the CAPS  ";
    const text = renderElementRequest({
      projectDir: "/p",
      compositionPath: "index.html",
      time: 0,
      target: { tagName: "div" },
      instruction,
    });
    expect(text).toContain("keep  the double spaces and the CAPS");
  });
});

describe("element targets", () => {
  it("identifies the element by selector, tag and stable id", () => {
    const text = elementRequest();
    expect(text).toContain("`.lines`");
    expect(text).toContain("`<ul>`");
    expect(text).toContain("hf-abc");
  });

  it("names the source file, so the reader can open it directly", () => {
    expect(elementRequest()).toContain("compositions/cover.html");
  });

  it("gives the box in composition pixels, not percentages", () => {
    /*
     * An annotation works in normalized coordinates because it has nothing else. An
     * element has a real box in the composition's own space, and that is what the reader
     * needs to reason about layout.
     */
    expect(elementRequest()).toContain("x=120, y=240, w=400, h=200");
  });

  it("attaches no screenshot", () => {
    /*
     * A picture would be a second, less precise description of something already
     * identified by selector. It invites editing the pixels instead of the DOM.
     */
    expect(elementRequest()).not.toContain("Frame capture");
    expect(elementRequest()).not.toContain(".png");
  });

  it("falls back to the tag when the element has no label", () => {
    const text = renderElementRequest({
      projectDir: "/p",
      compositionPath: "index.html",
      time: 0,
      target: { tagName: "SECTION" },
      instruction: "x",
    });
    expect(text).toContain("### <section>");
  });

  it("clips a long text so one element cannot swallow the prompt", () => {
    const text = renderElementRequest({
      projectDir: "/p",
      compositionPath: "index.html",
      time: 0,
      target: { tagName: "p", text: "word ".repeat(200) },
      instruction: "x",
    });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(4000);
  });

  it("fences the markup as code, so its boundaries are unambiguous", () => {
    const text = renderElementRequest({
      projectDir: "/p",
      compositionPath: "index.html",
      time: 0,
      target: { tagName: "div" },
      instruction: "x",
      markup: "<div class='a'><span>hi</span></div>",
    });
    expect(text).toContain("```html");
    expect(text).toContain("<span>hi</span>");
    expect(text.trimEnd().endsWith("```") === false).toBe(true);
  });

  it("omits the markup section entirely when there is none", () => {
    expect(elementRequest()).not.toContain("## Target HTML");
  });

  it("formats the timecode exactly like the annotation prompt does", () => {
    // Both producers describe the same playhead; a different format reads as a
    // different thing.
    expect(elementRequest()).toContain("00:12.500 (12.500s)");
  });
});
