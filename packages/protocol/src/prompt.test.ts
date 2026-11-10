import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationBundle, ArrowAnnotation, RegionAnnotation } from "../src/annotation.js";
import { formatTimecode, describeTime, isReferenceableShape } from "../src/annotation.js";
import { dropAnnotationRef, renumberBlockRefs } from "../src/prompt.js";
import { validateBundle } from "../src/sink.js";
import { blockCount } from "../src/prompt.js";
import {
  annotationRef,
  appendAnnotationRef,
  dropAnnotationRef,
  renumberAnnotationRefs,
  renderAnnotation,
  renderBundle,
  renderUserPrompt,
} from "../src/prompt.js";

function bundleWith(annotations: Annotation[]): AnnotationBundle {
  return {
    schemaVersion: 1,
    projectDir: "/projects/demo",
    projectId: "demo",
    summary: "",
    annotations,
    createdAt: 1_700_000_000_000,
  };
}

const region: RegionAnnotation = {
  kind: "region",
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
};

const arrow: ArrowAnnotation = {
  kind: "arrow",
  from: { x: 0.2, y: 0.3 },
  to: { x: 0.8, y: 0.7 },
};

function annotation(over: Partial<Annotation> & Pick<Annotation, "id" | "shape">): Annotation {
  return {
    frame: {
      compositionPath: "index.html",
      time: 12.5,
      compositionWidth: 1920,
      compositionHeight: 1080,
    },
    note: "",
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe("formatTimecode", () => {
  it("formats sub-hour times as mm:ss.mmm", () => {
    expect(formatTimecode(0)).toBe("00:00.000");
    expect(formatTimecode(12.5)).toBe("00:12.500");
    expect(formatTimecode(65.25)).toBe("01:05.250");
    expect(formatTimecode(3599.999)).toBe("59:59.999");
  });

  it("adds an hour field past 60 minutes", () => {
    expect(formatTimecode(3600)).toBe("1:00:00.000");
    expect(formatTimecode(3725.5)).toBe("1:02:05.500");
  });

  it("degrades invalid input to zero rather than NaN", () => {
    expect(formatTimecode(Number.NaN)).toBe("00:00.000");
    expect(formatTimecode(-5)).toBe("00:00.000");
  });
});

describe("what a block says about its shape", () => {
  function region(withPicture: boolean) {
    return {
      id: "a1",
      shape: { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      frame: { compositionPath: "index.html", time: 1, compositionWidth: 1920, compositionHeight: 1080 },
      note: "",
      createdAt: 1,
      ...(withPicture ? { frameImagePath: "/p/.mystudio/frames/a1.png" } : {}),
    } as const;
  }

  it("describes a region by its picture, not by its coordinates", () => {
    /*
     * The user's objection to coordinates-only: "你要是光告诉个坐标…他也不知道圈了哪些内容呀".
     * With the frame attached, the rectangle adds nothing a reader can use — they can see
     * what was circled.
     */
    const text = renderAnnotation(region(true), 0);
    expect(text).toContain("Frame capture");
    expect(text).not.toContain("x 10.0%");
  });

  it("falls back to coordinates when there is no picture", () => {
    // An old payload, or a failed capture: something has to locate the area.
    const text = renderAnnotation(region(false), 0);
    expect(text).toContain("Area:");
    expect(text).toContain("20.0%");
  });

  it("always states an arrow's two points, because they are its meaning", () => {
    // "move this thing from here to there" cannot be expressed by a picture alone.
    const arrow = {
      id: "a2",
      shape: { kind: "arrow", from: { x: 0.2, y: 0.8 }, to: { x: 0.6, y: 0.3 } },
      frame: { compositionPath: "index.html", time: 1, compositionWidth: 1920, compositionHeight: 1080 },
      note: "",
      createdAt: 1,
      frameImagePath: "/p/.mystudio/frames/a2.png",
    } as const;
    const text = renderAnnotation(arrow, 1);
    expect(text).toContain("(20.0%, 80.0%)");
    expect(text).toContain("(60.0%, 30.0%)");
  });
});

describe("an element block", () => {
  const base = {
    schemaVersion: 1 as const,
    projectDir: "/p",
    projectId: "p",
    summary: "",
    annotations: [],
    createdAt: 1,
  };
  const target = { tagName: "h1", selector: ".title", text: "Hello", sourceFile: "index.html" };

  it("carries both the picture and the element's own description", () => {
    /*
     * The picture answers "which thing did the user point at"; the description answers "how
     * do I find it in the code". One does not replace the other (found.md F-100).
     */
    const text = renderBundle({
      ...base,
      elements: [{ ref: "Element 1", target, frameImagePath: "/p/.mystudio/frames/e1.png" }],
    });
    expect(text).toContain("### Element 1");
    expect(text).toContain("Selector");
    expect(text).toContain("Frame capture");
  });

  it("still describes the element when the capture is missing", () => {
    const text = renderBundle({ ...base, elements: [{ ref: "Element 1", target }] });
    expect(text).toContain("Selector");
    expect(text).not.toContain("Frame capture");
  });
});

describe("the block sequence is shared across kinds", () => {
  it("removes a reference and closes the gap it left", () => {
    /*
     * The reported symptom: after deleting blocks the box showed plain text instead of chips.
     * Cause: the text was renumbered by kind while the numbers were request-wide, so the
     * lines named numbers no block had and the parser refused to lift them into atoms
     * (found.md F-108).
     */
    const text = "Capture 1\nCapture 2\nCapture 3";
    const dropped = dropAnnotationRef(text, 2);
    expect(dropped).toBe("Capture 1\nCapture 3");
    expect(renumberBlockRefs(dropped, 2)).toBe("Capture 1\nCapture 2");
  });

  it("leaves no empty line where a block used to be", () => {
    // A reference owns its line; deleting it must not leave a growing gap.
    expect(dropAnnotationRef("a\nCapture 2\nb", 2)).toBe("a\nb");
  });

  it("renumbers across kinds, not within one", () => {
    // `Region 3` becomes `Region 2` when something before it goes, even though no other
    // region exists.
    expect(renumberBlockRefs("Region 3", 1)).toBe("Region 2");
    expect(renumberBlockRefs("Capture 4", 2)).toBe("Capture 3");
  });
});

describe("describeTime", () => {
  it("states the timecode in both forms so the reader cannot misread it", () => {
    expect(describeTime(12.5)).toContain("00:12.500");
    expect(describeTime(12.5)).toContain("mm:ss.mmm");
  });
});

describe("renderAnnotation", () => {
  it("states the file, the timecode and the canvas size for every shape", () => {
    const text = renderAnnotation(annotation({ id: "a1", shape: region }), 0);
    expect(text).toContain("index.html");
    expect(text).toContain("00:12.500");
    expect(text).toContain("12.500s");
    expect(text).toContain("1920×1080");
  });

  it("describes a region by its normalized bounds", () => {
    const text = renderAnnotation(annotation({ id: "a1", shape: region }), 0);
    expect(text).toContain("Region");
    expect(text).toContain("10.0%–40.0%");
    expect(text).toContain("20.0%–60.0%");
  });

  it("heads each block with the same reference the user sees in the prompt box", () => {
    // `Region 1` typed by the user has to resolve to `### Region 1` in the details.
    const text = renderAnnotation(annotation({ id: "a1", shape: region }), 0);
    expect(text.startsWith("### Region 1")).toBe(true);
  });

  it("numbers the heading by position, so a second arrow is Arrow 2", () => {
    const text = renderAnnotation(annotation({ id: "a2", shape: arrow }), 1);
    expect(text.startsWith("### Arrow 2")).toBe(true);
  });

  it("describes an arrow as moving from tail to head", () => {
    const text = renderAnnotation(annotation({ id: "a2", shape: arrow }), 1);
    expect(text).toContain("Arrow move");
    expect(text).toContain("(20.0%, 30.0%)");
    expect(text).toContain("(80.0%, 70.0%)");
    expect(text).toContain("move or adjust");
  });

  it("carries the element identity when the arrow points at one", () => {
    const text = renderAnnotation(
      annotation({
        id: "a3",
        shape: arrow,
        element: {
          hfId: "hf-abc123",
          tagName: "h1",
          selector: "#title",
          text: "Hello world",
          box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        },
      }),
      0,
    );
    expect(text).toContain('hf-id="hf-abc123"');
    expect(text).toContain("<h1>");
    expect(text).toContain("`#title`");
    expect(text).toContain("Hello world");
  });

  it("omits the element line when no element is involved", () => {
    const text = renderAnnotation(annotation({ id: "a4", shape: region }), 0);
    expect(text).not.toContain("Element:");
  });

  it("includes the user's note and the screenshot path when present", () => {
    const text = renderAnnotation(
      annotation({
        id: "a5",
        shape: region,
        note: "nudge this line a little to the left",
        frameImagePath: "/tmp/frame-12.5.png",
      }),
      0,
    );
    expect(text).toContain("nudge this line a little to the left");
    expect(text).toContain("/tmp/frame-12.5.png");
  });

  it("truncates very long element text so the prompt stays readable", () => {
    const text = renderAnnotation(
      annotation({
        id: "a6",
        shape: region,
        element: { text: "x".repeat(200) },
      }),
      0,
    );
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(120));
  });
});

describe("renderBundle", () => {
  it("numbers annotations and keeps a stable section order", () => {
    const text = renderBundle(
      bundleWith([
        annotation({ id: "a1", shape: region }),
        annotation({
          id: "a2",
          shape: arrow,
          frame: {
            compositionPath: "compositions/intro.html",
            time: 3,
            compositionWidth: 1080,
            compositionHeight: 1920,
          },
        }),
      ]),
    );
    expect(text).toContain("### Region 1");
    expect(text).toContain("### Arrow 2");
    expect(text.indexOf("## Annotation details")).toBeLessThan(text.indexOf("## What to do"));
    expect(text).toContain("compositions/intro.html");
  });

  it("summarises the covered time span", () => {
    const text = renderBundle(
      bundleWith([
        annotation({ id: "a1", shape: region, frame: { compositionPath: "index.html", time: 2, compositionWidth: 1920, compositionHeight: 1080 } }),
        annotation({ id: "a2", shape: region, frame: { compositionPath: "index.html", time: 9, compositionWidth: 1920, compositionHeight: 1080 } }),
      ]),
    );
    /*
     * Same composition, so the two moments are listed under one file. The old span
     * (`00:02.000 – 00:09.000`) implied a continuous range, which is only true by accident
     * when everything is on one composition — see the cross-composition test below.
     */
    expect(text).toContain("## Where to look");
    expect(text).toContain("- Composition `index.html`: 00:02.000 (2.000s), 00:09.000 (9.000s)");
  });

  it("states a single timepoint as one timecode, not a range", () => {
    const text = renderBundle(bundleWith([annotation({ id: "a1", shape: region })]));
    expect(text).toContain("- Composition `index.html`: 00:12.500 (12.500s)");
    // Scoped to the section: the guardrails legitimately contain an en dash elsewhere.
    const section = text.slice(text.indexOf("## Where to look"), text.indexOf("## Targets"));
    expect(section).not.toContain("–");
  });

  it("includes the project summary only when the user wrote one", () => {
    const empty = renderBundle(bundleWith([annotation({ id: "a1", shape: region })]));
    expect(empty).not.toContain("## Overview");

    const withSummary = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: region })]),
      summary: "the pacing is too slow overall",
    });
    expect(withSummary).toContain("the pacing is too slow overall");
  });

  it("ends with actionable instructions, not an open question", () => {
    const text = renderBundle(bundleWith([annotation({ id: "a1", shape: region })]));
    expect(text).toContain("npx hyperframes lint");
    expect(text).toContain("npx hyperframes check");
  });

  it("names the project directory so the agent knows where to work", () => {
    const text = renderBundle(bundleWith([annotation({ id: "a1", shape: region })]));
    expect(text).toContain("/projects/demo");
  });
});

describe("annotationRef", () => {
  it("produces the block reference shown in the prompt box", () => {
    expect(annotationRef("region", 0)).toBe("Region 1");
    expect(annotationRef("arrow", 1)).toBe("Arrow 2");
  });

  it("has no reference for ink, because ink is not a block", () => {
    /*
     * Handwriting is content, not a pointer at something. Numbering it would consume an
     * ordinal, so `Arrow 1` could become `Arrow 2` merely because the user scribbled in
     * between — silently repointing a sentence they already wrote.
     */
    expect(isReferenceableShape("freehand")).toBe(false);
  });
});

describe("renumberAnnotationRefs", () => {
  it("shifts later references down when an earlier block is removed", () => {
    // Badges are positional, so `Arrow 3` must not keep pointing at the old third block.
    expect(renumberAnnotationRefs("Region 1 and Arrow 3", 1)).toBe("Region 1 and Arrow 2");
  });

  it("leaves references before the removed block untouched", () => {
    expect(renumberAnnotationRefs("Region 1, Arrow 2", 3)).toBe("Region 1, Arrow 2");
  });

  it("handles multi-digit ordinals", () => {
    expect(renumberAnnotationRefs("Arrow 12", 5)).toBe("Arrow 11");
  });

  it("returns text without references unchanged", () => {
    expect(renumberAnnotationRefs("make it snappier", 2)).toBe("make it snappier");
  });
});

describe("dropAnnotationRef", () => {
  it("removes only the deleted block's reference", () => {
    expect(dropAnnotationRef("Region 1 and Arrow 2", 1)).toBe("and Arrow 2");
  });

  it("does not leave doubled or dangling spaces behind", () => {
    expect(dropAnnotationRef("move Region 1 to the left", 1)).toBe("move to the left");
  });

  it("cleans a space before punctuation", () => {
    expect(dropAnnotationRef("Region 1, please", 1)).toBe(", please");
  });

  it("returns an empty string when the reference was the whole text", () => {
    expect(dropAnnotationRef("Region 1", 1)).toBe("");
  });
});

describe("renderUserPrompt", () => {
  const bundle = bundleWith([annotation({ id: "a1", shape: region })]);

  it("uses the user's words as the request section", () => {
    const text = renderUserPrompt(bundle, "Region 1 should be darker");
    expect(text).toContain("## What I want");
    expect(text).toContain("Region 1 should be darker");
  });

  it("still appends the machine details the block reference stands for", () => {
    /*
     * The whole point: the prompt box shows `Region 1` only, so the delivered text
     * must carry the coordinates, timecode and capture path or the agent cannot act.
     */
    const text = renderUserPrompt(bundle, "Region 1 should be darker");
    expect(text).toContain("### Region 1");
    expect(text).toContain("00:12.500");
    expect(text).toContain("10.0%–40.0%");
  });

  it("falls back to the generated prompt when the user wrote nothing", () => {
    expect(renderUserPrompt(bundle, "   ")).toBe(renderBundle(bundle));
  });

  it("does not emit an empty request heading", () => {
    expect(renderUserPrompt(bundle, "   ")).not.toContain("## What I want");
  });
});

describe("appendAnnotationRef — what pressing S does", () => {
  it("appends on a line of its own, because a block is its own unit", () => {
    expect(appendAnnotationRef("make it snappier", "Region 1")).toBe("make it snappier\nRegion 1");
  });

  it("appends to the end, never replacing what is already written", () => {
    // The user writes as they draw: circle, S, a sentence, circle, S again.
    const first = appendAnnotationRef("", "Region 1");
    const second = appendAnnotationRef(first, "Arrow 2");
    expect(second).toBe("Region 1\nArrow 2");
  });

  it("starts a fresh prompt with the reference alone", () => {
    expect(appendAnnotationRef("", "Region 1")).toBe("Region 1");
    expect(appendAnnotationRef("   \n  ", "Region 1")).toBe("Region 1");
  });

  it("does not add a blank line on repeated presses", () => {
    // Trailing whitespace from an earlier press must not push the text down a line.
    expect(appendAnnotationRef("hello\n\n", "Arrow 1")).toBe("hello\nArrow 1");
  });

  it("keeps the user's own trailing punctuation intact", () => {
    expect(appendAnnotationRef("darker please.", "Region 1")).toBe("darker please.\nRegion 1");
  });
});

describe("withdrawn marks", () => {
  it("states plainly that the mark is gone", () => {
    /*
     * Undo removes the drawing but leaves the user's sentence naming its block. Saying
     * "withdrawn" is the only honest option: silently dropping the block would leave
     * the sentence pointing at a heading that no longer exists.
     */
    const text = renderAnnotation(annotation({ id: "a1", shape: region, withdrawn: true }), 0);
    expect(text).toContain("### Region 1");
    expect(text).toContain("withdrawn");
  });

  it("says nothing about withdrawal for a live mark", () => {
    const text = renderAnnotation(annotation({ id: "a1", shape: region }), 0);
    expect(text).not.toContain("withdrawn");
  });

  it("keeps the block's ordinal, so block references do not shift", () => {
    const text = renderAnnotation(annotation({ id: "a2", shape: arrow, withdrawn: true }), 1);
    expect(text).toContain("### Arrow 2");
  });
});

describe("handwriting", () => {
  /** A bundle that carries only ink — no numbered block at all. */
  function inkOnlyBundle(): AnnotationBundle {
    return {
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_1.png" },
        { compositionPath: "index.html", time: 9, imagePath: "/frames/ink_2.png" },
      ],
    };
  }

  it("is delivered as a picture of the frame, not as a block", () => {
    /*
     * Ink has no reference and no coordinates worth reading. What communicates it is the
     * frame as the user sees it, so the prompt points at the image and says what it is.
     *
     * A picture is a block now, in its numbered place under `Targets` — not a section of its
     * own after the others. A reader resolving "the picture at 4 seconds" should not have to
     * walk past every other block to find it (found.md F-129).
     */
    const text = renderBundle(inkOnlyBundle());
    expect(text).toContain("### Handwriting 1");
    expect(text).toContain("### Handwriting 2");
    expect(text).toContain("the frame as the user drew on it");
    expect(text).toContain("/frames/ink_1.png");
    expect(text).not.toContain("Freehand");
    expect(text).not.toContain("## Handwriting\n");
  });

  it("names the composition and timecode for each picture", () => {
    // Without these the reader has a picture and no idea which frame it belongs to.
    const text = renderBundle(inkOnlyBundle());
    expect(text).toContain("00:04.000 (4.000s)");
    expect(text).toContain("00:09.000 (9.000s)");
  });

  it("lists the ink timecodes even with no numbered blocks", () => {
    // Both captures are on `index.html`, so they group under one file.
    expect(renderBundle(inkOnlyBundle())).toContain(
      "- Composition `index.html`: 00:04.000 (4.000s), 00:09.000 (9.000s)",
    );
  });

  it("lists one entry per capture, and does not repeat the same file", () => {
    /*
     * A capture is a block, so two captures of one frame are two entries — but the *same*
     * file repeated three times is still one picture, and printing it three times would make
     * the reader open it repeatedly looking for a difference.
     */
    const text = renderBundle({
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_1.png" },
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_1.png" },
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_1.png" },
      ],
    });
    expect(text.split("/frames/ink_1.png")).toHaveLength(2);
  });

  it("lists two captures of one frame as two blocks", () => {
    /*
     * The user's model: "arrow1 element2 capture3, 这包含了3张图片… 假如说我又绘制了有新东西，
     * 那就是 capture4". Drawing again and adding another capture keeps both, each with its own
     * reference, so the reader can follow the progression.
     */
    const text = renderBundle({
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_1.png", ref: "Capture 1" },
        { compositionPath: "index.html", time: 4, imagePath: "/frames/ink_2.png", ref: "Capture 2" },
      ],
    });
    expect(text).toContain("### Capture 1");
    expect(text).toContain("### Capture 2");
    expect(text).toContain("/frames/ink_1.png");
    expect(text).toContain("/frames/ink_2.png");
  });

  it("keeps numbered blocks and handwriting in the same delivery", () => {
    // The common case: circle something, write `Arrow 1`, then scribble a note.
    const text = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: arrow })]),
      ink: [{ compositionPath: "index.html", time: 12.5, imagePath: "/frames/ink_1.png" }],
    });
    expect(text).toContain("### Arrow 1");
    expect(text).toContain("## Handwriting");
    // Blocks come first: they are what the user's sentences name.
    expect(text.indexOf("### Arrow 1")).toBeLessThan(text.indexOf("## Handwriting"));
  });

  it("tells the reader the handwriting is the instruction, not decoration", () => {
    const text = renderBundle(inkOnlyBundle());
    expect(text).toContain("do not reproduce it in the output");
  });
});

describe("handwriting-only delivery header", () => {
  it("does not claim zero annotations when the payload has none", () => {
    // "Annotations: 0" reads like a failed delivery; the real content is the picture.
    const text = renderBundle({
      ...bundleWith([]),
      ink: [{ compositionPath: "index.html", time: 0, imagePath: "/frames/ink.png" }],
    });
    expect(text).not.toContain("Annotations: 0");
    expect(text).toContain("  - Handwriting captures: 1");
  });

  it("counts captures in blocks, and frames separately", () => {
    /*
     * The header used to say `Blocks: 2` and, directly beneath, `Handwritten frames: 1` — both
     * true, and together reading as a mistake. `Blocks` counts blocks, so the line under it has
     * to count blocks too; frames are worth knowing because they say how much seeking is
     * required, so they are named in parentheses rather than replacing the count
     * (found.md F-130).
     */
    const text = renderBundle({
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 0, imagePath: "/frames/a.png" },
        { compositionPath: "index.html", time: 0, imagePath: "/frames/b.png" },
        { compositionPath: "index.html", time: 3, imagePath: "/frames/c.png" },
      ],
    });
    expect(text).toContain("- Blocks: 3");
    expect(text).toContain("  - Handwriting captures: 3 (on 2 frames)");
  });

  it("never states a kind count larger than the total", () => {
    // The property the contradiction violated: every sub-count is a slice of the total.
    const text = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: arrow })]),
      ink: [
        { compositionPath: "index.html", time: 0, imagePath: "/frames/a.png" },
        { compositionPath: "index.html", time: 0, imagePath: "/frames/b.png" },
      ],
    });
    const total = Number(/(?:^|\n)- Blocks: (\d+)/.exec(text)?.[1]);
    const captures = Number(/Handwriting captures: (\d+)/.exec(text)?.[1] ?? 0);
    const marks = Number(/Numbered marks[^:]*: (\d+)/.exec(text)?.[1] ?? 0);
    expect(total).toBe(3);
    expect(captures + marks).toBeLessThanOrEqual(total);
  });

  it("still lists annotations when both kinds are present", () => {
    const text = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: arrow })]),
      ink: [{ compositionPath: "index.html", time: 0, imagePath: "/frames/ink.png" }],
    });
    expect(text).toContain("- Blocks: 2");
    expect(text).toContain("  - Numbered marks (regions and arrows): 1");
    expect(text).toContain("  - Handwriting captures: 1");
  });
});

describe("elements in the same request", () => {
  function withElement(): AnnotationBundle {
    return {
      ...bundleWith([annotation({ id: "a1", shape: arrow })]),
      elements: [
        {
          ref: "Element 1",
          target: { tagName: "ul", selector: ".lines", sourceFile: "compositions/cover.html" },
        },
      ],
    };
  }

  it("appears under Targets with the same block heading as a mark", () => {
    /*
     * An element is a thing the user named, exactly like `Arrow 1`. It has to resolve the
     * same way, or a sentence saying "Element 1" would point at nothing.
     */
    const text = renderBundle(withElement());
    expect(text).toContain("### Element 1");
    expect(text).toContain("### Arrow 1");
    expect(text.indexOf("### Element 1")).toBeGreaterThan(text.indexOf("## Targets"));
  });

  it("describes the element by what it is, not by where it is on the frame", () => {
    const text = renderBundle(withElement());
    expect(text).toContain("`.lines`");
    expect(text).toContain("compositions/cover.html");
  });

  it("does not duplicate the element heading", () => {
    // The element renderer makes its own `### label`; the bundle owns the numbering, so
    // only one heading may survive.
    const text = renderBundle(withElement());
    expect(text.split("### Element 1")).toHaveLength(2);
  });

  it("is enough on its own to send a request", () => {
    // Selecting an element and describing a change is a complete request: no mark needed.
    const text = renderBundle({
      ...bundleWith([]),
      elements: [{ ref: "Element 1", target: { tagName: "p" } }],
    });
    expect(text).toContain("### Element 1");
    expect(text).not.toContain("## Annotation details");
  });

  it("renumbers like any other block when one is deleted", () => {
    // Deleting block 1 is a two-step edit: drop it, then shift the rest down one.
    const withoutDeleted = dropAnnotationRef("shrink Element 1 and align Element 2", 1);
    expect(renumberAnnotationRefs(withoutDeleted, 1)).toBe("shrink and align Element 1");
    expect(dropAnnotationRef("move Element 2 up", 2)).toBe("move up");
  });
});

describe("whiteboard sketches", () => {
  /** A bundle with one video capture and one board sketch, both with refs. */
  function mixedBundle(): AnnotationBundle {
    return {
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 4, imagePath: "/frames/frame.png", ref: "Capture 1" },
        {
          compositionPath: "index.html",
          time: 4,
          imagePath: "/frames/board.png",
          ref: "Drawing 2",
          board: true,
        },
      ],
    };
  }

  it("is named Drawing, not Capture, because there is no frame behind it", () => {
    const text = renderBundle(mixedBundle());
    expect(text).toContain("### Drawing 2");
    expect(text).toContain("### Capture 1");
  });

  it("does not print a timecode or composition for a sketch", () => {
    /*
     * A sketch has no moment in the video. Printing one would be a lie the reader cannot
     * detect: it would go looking for that frame and find footage nobody drew on.
     */
    const text = renderBundle(mixedBundle());
    const sketchBlock = text.slice(text.indexOf("### Drawing 2"));
    expect(sketchBlock).not.toContain("- Timecode:");
    expect(sketchBlock).not.toContain("- Composition:");
    expect(sketchBlock).toContain("not** a moment of the video");
  });

  it("keeps the video capture's timecode even when both are present", () => {
    const text = renderBundle(mixedBundle());
    const frameBlock = text.slice(text.indexOf("### Capture 1"), text.indexOf("### Drawing 2"));
    expect(frameBlock).toContain("- Timecode: 00:04.000 (4.000s)");
  });

  it("excludes sketches from the covered timecodes", () => {
    // A page is not a covered moment; counting it would claim the request is about that time.
    const boardOnly: AnnotationBundle = {
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 30, imagePath: "/frames/board.png", board: true },
      ],
    };
    expect(renderBundle(boardOnly)).not.toContain("## Timecodes covered");
  });

  it("counts sketches separately from handwritten frames", () => {
    const text = renderBundle(mixedBundle());
    expect(text).toContain("- Handwriting captures: 1");
    expect(text).toContain("- Whiteboard sketches: 1");
  });

  it("heads a board-only delivery as sketches, not as handwriting on frames", () => {
    const boardOnly: AnnotationBundle = {
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 0, imagePath: "/frames/board.png", board: true },
      ],
    };
    const text = renderBundle(boardOnly);
    // The sketch is stated as a sketch, not as handwriting on a frame.
    expect(text).toContain("### Sketch");
    expect(text).toContain("**not** a moment of the video");
    expect(text).toContain("- Whiteboard sketches: 1");
    expect(text).not.toContain("- Handwriting captures:");
  });

  it("is renumbered by the shared sequence like any other block", () => {
    // `Drawing 2` sits in one sequence with `Capture 1`: deleting the first moves it to 1.
    expect(renumberBlockRefs("Drawing 2\nRegion 1", 1)).toBe("Drawing 1\nRegion 1");
    expect(dropAnnotationRef("Capture 1\nDrawing 2", 2)).toBe("Capture 1");
  });

  it("counts as content when it is the only thing to deliver", () => {
    const boardOnly: AnnotationBundle = {
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 0, imagePath: "/frames/board.png", board: true },
      ],
    };
    expect(validateBundle(boardOnly)).toBeNull();
  });
});

describe("where to look: one composition per line", () => {
  /** Two marks on **different** compositions of the same project. */
  function twoCompositions(): AnnotationBundle {
    return bundleWith([
      annotation({
        id: "a1",
        shape: region,
        frame: {
          compositionPath: "index.html",
          time: 2,
          compositionWidth: 1920,
          compositionHeight: 1080,
        },
      }),
      annotation({
        id: "a2",
        shape: region,
        frame: {
          compositionPath: "compositions/cover.html",
          time: 10,
          compositionWidth: 1920,
          compositionHeight: 1080,
        },
      }),
    ]);
  }

  it("never collapses moments from different compositions into one range", () => {
    /*
     * The defect this replaces: `00:02.000 – 00:10.000` reads as one continuous span, and its
     * endpoints are not even on the same axis — `cover.html` has its own playhead starting at 0.
     * A reader cannot detect that the range is meaningless.
     */
    const text = renderBundle(twoCompositions());
    expect(text).not.toMatch(/00:02\.000[^\n]*–/);
    expect(text).toContain("- Composition `compositions/cover.html`: 00:10.000 (10.000s)");
    expect(text).toContain("- Composition `index.html`: 00:02.000 (2.000s)");
  });

  it("gives each composition its own line, sorted by path", () => {
    const text = renderBundle(twoCompositions());
    const where = text.slice(text.indexOf("## Where to look"), text.indexOf("## Targets"));
    const lines = where.split("\n").filter((line) => line.startsWith("- Composition"));
    expect(lines).toHaveLength(2);
    // Sorted, so the section is stable between renders.
    expect(lines[0]).toContain("compositions/cover.html");
    expect(lines[1]).toContain("index.html");
  });

  it("lists an element's frame, so its picture can be reproduced", () => {
    /*
     * An `Element N` block's picture is a picture of one frame. Without that frame in the
     * request, the reader is handed evidence it cannot locate.
     */
    const text = renderBundle({
      ...bundleWith([]),
      elements: [
        {
          ref: "Element 1",
          target: { tagName: "ul", selector: ".lines", hfId: "hf-1" },
          frame: {
            compositionPath: "compositions/cover.html",
            time: 0.5,
            compositionWidth: 1920,
            compositionHeight: 1080,
          },
        },
      ],
    });
    expect(text).toContain("- Composition: `compositions/cover.html`");
    expect(text).toContain("- Timecode: 00:00.500 (0.500s)");
    expect(text).toContain("- Composition `compositions/cover.html`: 00:00.500 (0.500s)");
  });

  it("says where the element is inside its own block, not only in the summary", () => {
    const text = renderBundle({
      ...bundleWith([]),
      elements: [
        {
          ref: "Element 1",
          target: { tagName: "ul", selector: ".lines" },
          frame: {
            compositionPath: "compositions/cover.html",
            time: 0.5,
            compositionWidth: 1920,
            compositionHeight: 1080,
          },
        },
      ],
    });
    const block = text.slice(text.indexOf("### Element 1"), text.indexOf("## What to do"));
    expect(block).toContain("- Canvas: 1920×1080");
    expect(block).toContain("- Tag: `<ul>`");
  });

  it("still works for an older element payload that states no frame", () => {
    // Degrade to what is known instead of inventing a location.
    const text = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: region })]),
      elements: [{ ref: "Element 1", target: { tagName: "ul", selector: ".lines" } }],
    });
    const block = text.slice(text.indexOf("### Element 1"), text.indexOf("## What to do"));
    expect(block).not.toContain("- Timecode:");
    expect(block).toContain("- Tag: `<ul>`");
  });
});

describe("the header tells the reader what is in the request", () => {
  it("counts every block, whatever its kind", () => {
    /*
     * The outbox filename used `annotations.length`, so a request with one element and one
     * capture was written as `…_0items.json`. `blockCount` is the one definition of "items",
     * shared by the filename and the header.
     */
    const bundle: AnnotationBundle = {
      ...bundleWith([annotation({ id: "a1", shape: region })]),
      elements: [
        {
          ref: "Element 2",
          target: { tagName: "ul", selector: ".lines" },
          frame: {
            compositionPath: "index.html",
            time: 1,
            compositionWidth: 1920,
            compositionHeight: 1080,
          },
        },
      ],
      ink: [
        { compositionPath: "index.html", time: 2, imagePath: "/frames/cap.png", ref: "Capture 3" },
        { compositionPath: "index.html", time: 2, imagePath: "/frames/board.png", ref: "Drawing 4", board: true },
      ],
    };
    expect(blockCount(bundle)).toBe(4);
    const text = renderBundle(bundle);
    expect(text).toContain("- Blocks: 4");
    expect(text).toContain("  - Numbered marks (regions and arrows): 1");
    expect(text).toContain("  - Selected elements: 1");
    expect(text).toContain("  - Whiteboard sketches: 1");
  });

  it("lists every block reference in request order, before the details", () => {
    const text = renderBundle({
      ...bundleWith([annotation({ id: "a1", shape: region, ref: "Region 1" })]),
      elements: [
        {
          ref: "Element 2",
          target: { tagName: "ul", selector: ".lines" },
          frame: {
            compositionPath: "index.html",
            time: 1,
            compositionWidth: 1920,
            compositionHeight: 1080,
          },
        },
      ],
      ink: [{ compositionPath: "index.html", time: 2, imagePath: "/f/c.png", ref: "Capture 3" }],
    });
    const list = text.slice(text.indexOf("## Blocks in this request"), text.indexOf("## Where to look"));
    expect(list).toContain("`Region 1`");
    expect(list).toContain("`Element 2`");
    expect(list).toContain("`Capture 3`");
    // In number order, so the reader can see it is one sequence.
    expect(list.indexOf("Region 1")).toBeLessThan(list.indexOf("Element 2"));
    expect(list.indexOf("Element 2")).toBeLessThan(list.indexOf("Capture 3"));
  });

  it("does not claim the request is about 'the current video'", () => {
    /*
     * That assertion is false whenever the request names several compositions or a board page.
     * The composition names arrive in `Where to look` instead.
     */
    const text = renderBundle(bundleWith([annotation({ id: "a1", shape: region })]));
    expect(text).not.toContain("the current video");
    expect(text).toContain("annotated frames");
  });
});

describe("blocks are met in number order, not kind order", () => {
  /** Element 2 sits between Region 1 and Arrow 3 — the case that used to read "1, 3, 2". */
  function interleaved(): AnnotationBundle {
    const frame = { compositionPath: "index.html", time: 1, compositionWidth: 1920, compositionHeight: 1080 };
    return {
      ...bundleWith([
        { ...annotation({ id: "a1", shape: region }), ref: "Region 1" },
        { ...annotation({ id: "a3", shape: arrow }), ref: "Arrow 3" },
      ]),
      elements: [
        {
          ref: "Element 2",
          target: { tagName: "ul", selector: ".lines" },
          frame,
        },
      ],
    };
  }

  it("renders the detail blocks in the order their numbers claim", () => {
    /*
     * They used to be grouped by kind — all annotations, then all elements — so a request read
     * `Region 1`, `Arrow 3`, `Element 2`. A reader looking for `Element 2` had to scan past a
     * larger number, and could reasonably decide the numbering was broken (found.md F-129).
     */
    const text = renderBundle(interleaved());
    const body = text.slice(text.indexOf("## Targets"), text.indexOf("## What to do"));
    const order = ["### Region 1", "### Element 2", "### Arrow 3"].map((heading) => body.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("has exactly one heading per block, and no empty headings", () => {
    const text = renderBundle(interleaved());
    const body = text.slice(text.indexOf("## Targets"), text.indexOf("## What to do"));
    const headings = body.split("\n").filter((line) => line.startsWith("### "));
    expect(headings).toEqual(["### Region 1", "### Element 2", "### Arrow 3"]);
  });

  it("puts a picture in its numbered place, not after every other block", () => {
    const frame = { compositionPath: "index.html", time: 1, compositionWidth: 1920, compositionHeight: 1080 };
    const text = renderBundle({
      ...bundleWith([{ ...annotation({ id: "a1", shape: region }), ref: "Region 1" }]),
      ink: [{ compositionPath: "index.html", time: 1, imagePath: "/f/c.png", ref: "Capture 2" }],
      elements: [
        { ref: "Element 3", target: { tagName: "ul", selector: ".lines" }, frame },
      ],
    });
    const body = text.slice(text.indexOf("## Targets"), text.indexOf("## What to do"));
    expect(body.indexOf("### Region 1")).toBeLessThan(body.indexOf("### Capture 2"));
    expect(body.indexOf("### Capture 2")).toBeLessThan(body.indexOf("### Element 3"));
  });

  it("gives two unnamed pictures distinct headings", () => {
    // Two blocks both headed `### Handwriting` is ambiguous to every reader.
    const text = renderBundle({
      ...bundleWith([]),
      ink: [
        { compositionPath: "index.html", time: 1, imagePath: "/f/a.png" },
        { compositionPath: "index.html", time: 2, imagePath: "/f/b.png" },
      ],
    });
    expect(text).toContain("### Handwriting 1");
    expect(text).toContain("### Handwriting 2");
  });
});
