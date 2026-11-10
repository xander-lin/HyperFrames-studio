import { describe, expect, it } from "vitest";
import {
  clientToNormalized,
  describeElement,
  pickElementAt,
  toNormalized,
  toStagePixels,
} from "./geometry.js";

describe("toNormalized", () => {
  it("maps a pixel inside the stage to the 0..1 range", () => {
    expect(toNormalized({ x: 960, y: 540 }, { width: 1920, height: 1080 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it("clamps points dragged outside the stage, so annotations never go negative", () => {
    expect(toNormalized({ x: -50, y: 2000 }, { width: 1000, height: 1000 })).toEqual({
      x: 0,
      y: 1,
    });
  });

  it("returns the origin for a degenerate stage instead of dividing by zero", () => {
    expect(toNormalized({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("toStagePixels", () => {
  it("round-trips with toNormalized", () => {
    const stage = { width: 800, height: 600 };
    const point = { x: 0.25, y: 0.75 };
    expect(toNormalized(toStagePixels(point, stage), stage)).toEqual(point);
  });
});

describe("clientToNormalized", () => {
  it("subtracts the stage origin before normalising", () => {
    // The stage sits at (100, 50) in the window, sized 400×200.
    const stageRect = { left: 100, top: 50, width: 400, height: 200 };
    expect(clientToNormalized({ clientX: 300, clientY: 150 }, stageRect)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });
});

describe("pickElementAt", () => {
  function fakeDoc(hit: unknown): Document {
    return {
      defaultView: { innerWidth: 1000, innerHeight: 500, visualViewport: null },
      elementFromPoint: () => hit,
    } as unknown as Document;
  }

  it("returns null without a document, rather than throwing", () => {
    expect(pickElementAt(null, { x: 0.5, y: 0.5 })).toBeNull();
  });

  it("returns null when nothing is under the point", () => {
    expect(pickElementAt(fakeDoc(null), { x: 0.5, y: 0.5 })).toBeNull();
  });

  it("looks up the point in iframe viewport pixels", () => {
    let queried: { x: number; y: number } | null = null;
    const doc = {
      defaultView: { innerWidth: 1000, innerHeight: 500, visualViewport: null },
      elementFromPoint: (x: number, y: number) => {
        queried = { x, y };
        return null;
      },
    } as unknown as Document;
    pickElementAt(doc, { x: 0.25, y: 0.5 });
    expect(queried).toEqual({ x: 250, y: 250 });
  });

  it("skips Studio's own overlay nodes and walks up to a real element", () => {
    const parent = { tagName: "DIV", parentElement: null, hasAttribute: () => false };
    const overlay = {
      tagName: "CANVAS",
      parentElement: parent,
      hasAttribute: (name: string) => name === "data-mystudio-overlay",
    };
    expect(pickElementAt(fakeDoc(overlay), { x: 0.5, y: 0.5 })).toBe(parent);
  });

  it("gives up at <html> so we never annotate the document root", () => {
    const html = { tagName: "HTML", parentElement: null, hasAttribute: () => false };
    expect(pickElementAt(fakeDoc(html), { x: 0.5, y: 0.5 })).toBeNull();
  });
});

describe("describeElement", () => {
  function element(over: {
    tagName?: string;
    attrs?: Record<string, string>;
    classes?: string[];
    text?: string;
    box?: { left: number; top: number; width: number; height: number };
  }): Element {
    const attrs = over.attrs ?? {};
    return {
      tagName: over.tagName ?? "DIV",
      getAttribute: (name: string) => attrs[name] ?? null,
      classList: over.classes ?? [],
      textContent: over.text ?? "",
      getBoundingClientRect: () => over.box ?? { left: 0, top: 0, width: 0, height: 0 },
    } as unknown as Element;
  }

  it("prefers the stable Hyperframes id over everything else", () => {
    const ref = describeElement(
      element({ attrs: { "data-hf-id": "hf-abc", id: "title" }, tagName: "H1" }),
      { width: 1000, height: 500 },
    );
    expect(ref.hfId).toBe("hf-abc");
    expect(ref.id).toBe("title");
    expect(ref.tagName).toBe("h1");
  });

  it("uses a #id selector when there is no hf id", () => {
    const ref = describeElement(element({ attrs: { id: "headline" } }), {
      width: 100,
      height: 100,
    });
    expect(ref.selector).toBe("#headline");
  });

  it("falls back to tag plus the first two classes", () => {
    const ref = describeElement(element({ tagName: "P", classes: ["a", "b", "c"] }), {
      width: 100,
      height: 100,
    });
    expect(ref.selector).toBe("p.a.b");
  });

  it("falls back to the bare tag when nothing else identifies it", () => {
    const ref = describeElement(element({ tagName: "SPAN" }), { width: 100, height: 100 });
    expect(ref.selector).toBe("span");
  });

  it("normalises the bounding box against the stage", () => {
    const ref = describeElement(
      element({ box: { left: 100, top: 50, width: 200, height: 100 } }),
      { width: 1000, height: 500 },
    );
    expect(ref.box).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  });

  it("omits the box when the stage has no size yet", () => {
    const ref = describeElement(element({ box: { left: 1, top: 1, width: 2, height: 2 } }), {
      width: 0,
      height: 0,
    });
    expect(ref.box).toBeUndefined();
  });

  it("records the text content so the reader can identify text elements", () => {
    const ref = describeElement(element({ text: "  from this moment on  " }), { width: 10, height: 10 });
    expect(ref.text).toBe("from this moment on");
  });

  it("omits empty text instead of storing whitespace", () => {
    const ref = describeElement(element({ text: "   " }), { width: 10, height: 10 });
    expect(ref.text).toBeUndefined();
  });
});
