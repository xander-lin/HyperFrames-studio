import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The selection policy of the application, pinned down.
 *
 * ## The rule
 *
 * Chrome text — button labels, panel titles, property rows, hints — is not selectable.
 * Dragging across it is a window gesture, and the browser turning that into a blue
 * smear over "Record a gesture" reads as a bug.
 *
 * ## Why this test reads the stylesheet
 *
 * The rule *is* CSS. Rendering the whole Studio to assert a computed style is not
 * possible here, and a source grep would break on formatting. Reading the stylesheet and
 * asserting the **contract** keeps the guarantee meaningful:
 *
 * 1. something switches selection off for the application root;
 * 2. something switches it back on for fields, and only for fields;
 * 3. no rule switches it off for a field.
 *
 * ## History
 *
 * Scoping this per-overlay was the first attempt and it was wrong: Studio's own Design
 * panel kept its selection. The complaint was about the application, so the rule covers
 * the application.
 */

const css = readFileSync(new URL("./mystudio.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration block, as `{ selectors, body }`. */
function blocks(): Array<{ selectors: string; body: string }> {
  const found: Array<{ selectors: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    found.push({ selectors: match[1].trim(), body: match[2] });
  }
  return found;
}

function setsSelectionOff(body: string): boolean {
  return /(^|;|\s)(-webkit-)?user-select\s*:\s*none/.test(body);
}

function setsSelectionOn(body: string): boolean {
  return /(^|;|\s)(-webkit-)?user-select\s*:\s*text/.test(body);
}

/** Selectors that identify a place where a caret can exist. */
const FIELD_SELECTOR = /input|textarea|select|contenteditable|cm-content|data-mystudio-selectable/;

describe("application-wide default", () => {
  it("turns selection off at the application root", () => {
    /*
     * `#root` is the single mount point of the whole UI, so this covers Studio's own
     * panels as well as our floats. Scoping it to our overlays left Studio's Design
     * panel selectable — which is exactly what the user reported.
     */
    const ruled = blocks().filter(
      (block) => block.selectors.includes("#root") && setsSelectionOff(block.body),
    );
    expect(ruled.length).toBeGreaterThan(0);
  });

  it("covers html and body too, so nothing outside #root escapes", () => {
    const ruled = blocks().filter(
      (block) => /\bhtml\b/.test(block.selectors) && setsSelectionOff(block.body),
    );
    expect(ruled.length).toBeGreaterThan(0);
  });
});

describe("fields stay selectable", () => {
  it("re-enables selection for form controls", () => {
    // Selecting text in a field is the whole point of a field.
    const optIns = blocks().filter((block) => setsSelectionOn(block.body) && /input/.test(block.selectors));
    expect(optIns.length).toBeGreaterThan(0);

    const selectors = optIns.map((block) => block.selectors).join("\n");
    for (const field of ["textarea", "select", "contenteditable"]) {
      expect(selectors).toContain(field);
    }
  });

  it("re-enables the code editor, which is a contenteditable too", () => {
    /*
     * CodeMirror lives in `.cm-content` with `contenteditable=true`. A blanket
     * `contenteditable` rule would cover it — this assertion exists so a future
     * refactor cannot quietly lock the code editor.
     */
    const selectors = blocks()
      .filter((block) => setsSelectionOn(block.body))
      .map((block) => block.selectors)
      .join("\n");
    expect(selectors).toContain("cm-content");
  });

  it("never switches selection off for a field", () => {
    // A blanket rule that happens to match a field would silently kill editing.
    const harmful = blocks().filter(
      (block) => setsSelectionOff(block.body) && FIELD_SELECTOR.test(block.selectors),
    );
    expect(harmful).toEqual([]);
  });
});

describe("dragging on the canvas cannot select", () => {
  it("marks the input shield and the drawing canvas as non-selectable", () => {
    /*
     * `user-select` stops the *result*; the selection guard stops the *gesture*. Both
     * are needed: the guard needs a start point, and the canvas is where drags begin.
     */
    const selectors = blocks()
      .filter((block) => setsSelectionOff(block.body))
      .map((block) => block.selectors)
      .join("\n");
    expect(selectors).toContain('data-mystudio-overlay="shield"');
    expect(selectors).toContain('data-mystudio-overlay="annotation-canvas"');
  });
});

describe("the borrowed Design panel", () => {
  it("is forced non-selectable on every descendant", () => {
    /*
     * It is Studio's markup moved into our float and it brings its own `user-select`
     * declarations, some of which opt back into `text`. Inheriting "off" is not enough:
     * a descendant that switches it back on wins.
     */
    const ruled = blocks().filter(
      (block) =>
        block.selectors.includes('data-mystudio-overlay="inspector-host"') &&
        block.selectors.includes("*") &&
        setsSelectionOff(block.body),
    );
    expect(ruled.length).toBeGreaterThan(0);
  });
});
