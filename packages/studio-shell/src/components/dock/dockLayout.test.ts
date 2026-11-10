// @vitest-environment happy-dom

import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySideMinimums,
  buildEditLayout,
  defaultSideWidths,
  layoutFloors,
  sideMinimumWidth,
} from "./dockLayout";
import { mountBareDockview } from "./dockTestHarness";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

/**
 * Floors are derived from the width, not fixed.
 *
 * The rule: the preview keeps a comfortable 360 while it can, gives ground after that, and
 * never drops below 160; the two side columns split what is left, between 200 (comfortable)
 * and 60 (a column of tabs is still clickable). These numbers are pinned because they are
 * a promise to the window: three columns must fit, and the sum must never exceed the width.
 */
describe("sideMinimumWidth", () => {
  it.each([
    [1680, 200],
    [1200, 200],
    [860, 200],
    [760, 200],
    [700, 170],
    [600, 120],
    [560, 100],
    [400, 100],
  ])("is %ipx wide -> sides shrink to %ipx at most", (viewport, expected) => {
    expect(sideMinimumWidth(viewport)).toBe(expected);
  });

  it.each([1680, 1280, 1000, 860, 760, 700, 600, 560, 480, 420, 400, 360])(
    "leaves the three columns able to fit inside %ipx",
    (viewport) => {
      /*
       * This is the invariant the fixed floors violated, and the reason the window could
       * not get small: 360 + 120 + 120 needed 600px, so anything narrower overflowed its
       * own box and the right column was clipped. No floor may ask for room that is not
       * there.
       */
      const { previewWidth, sideWidth } = layoutFloors(viewport);
      expect(previewWidth + 2 * sideWidth).toBeLessThanOrEqual(viewport);
    },
  );

  it("never squeezes the preview below a recognisable picture", () => {
    // A 360px floor at 200px width is not a floor, it is a refusal to be small.
    for (const viewport of [1680, 860, 600, 480, 420, 360]) {
      expect(layoutFloors(viewport).previewWidth).toBeGreaterThanOrEqual(160);
    }
  });
});

describe("defaultSideWidths", () => {
  it.each([
    [1680, 384, 424],
    [1280, 329, 364],
    [860, 221, 244],
    [560, 100, 100],
  ])("at %ipx gives %i / %i", (viewport, left, right) => {
    expect(defaultSideWidths(viewport)).toEqual({ left, right });
  });

  it.each([1680, 1280, 1000, 860, 760, 700, 600, 560, 480, 420])(
    "leaves the preview its floor at %ipx whenever the sides can shrink enough",
    (viewport) => {
      const { left, right } = defaultSideWidths(viewport);
      const floor = sideMinimumWidth(viewport);
      const overflow = left + right + layoutFloors(viewport).previewWidth - viewport;
      expect(overflow <= 0 || (left === floor && right === floor)).toBe(true);
    },
  );

  it("gives a tiny window nothing but floors, and still fits", () => {
    // Below ~500px there is no comfortable answer; the layout must settle for the floors
    // rather than overflow. Overflowing is what made the window unusable when small.
    const { left, right } = defaultSideWidths(420);
    const { previewWidth } = layoutFloors(420);
    expect(left + right + previewWidth).toBeLessThanOrEqual(420);
  });
});

describe("layoutFloors — vertical", () => {
  it("keeps the timeline and preview inside a short window", () => {
    for (const height of [720, 600, 480, 400, 360, 340]) {
      const { previewHeight, timelineHeight } = layoutFloors(860, height);
      // 8px is the gutter the dock's cards add around each group.
      expect(previewHeight + timelineHeight + 8).toBeLessThanOrEqual(height);
    }
  });

  it("does not demand a 200px preview in a very short window", () => {
    /*
     * The old constant did, which was the vertical half of "the window cannot get
     * smaller". At the app's minimum height the comfortable 200px still fits, so this
     * checks a height below that: the preview must give ground instead of overflowing.
     */
    expect(layoutFloors(860, 240).previewHeight).toBeLessThan(200);
    expect(layoutFloors(860, 240).timelineHeight).toBeLessThan(100);
  });

  it("keeps the comfortable floors when there is room", () => {
    const floors = layoutFloors(1680, 1020);
    expect(floors.previewWidth).toBe(360);
    expect(floors.sideWidth).toBe(200);
    expect(floors.previewHeight).toBe(200);
    expect(floors.timelineHeight).toBe(100);
  });

  it("reports the comfortable heights when only a width is known", () => {
    // Callers that cannot measure height must not accidentally ask for zero.
    expect(layoutFloors(1200).previewHeight).toBe(200);
    expect(layoutFloors(1200).timelineHeight).toBe(100);
  });
});

describe("applySideMinimums", () => {
  let api: DockviewApi;
  beforeEach(() => {
    ({ api } = mountBareDockview());
  });
  afterEach(() => {
    api.dispose();
    document.body.innerHTML = "";
  });

  it("lowers side groups' minimum on a narrow window and shrinks them, never touching the preview", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    applySideMinimums(api, 560);
    expect(api.getPanel("compositions")?.group.minimumWidth).toBe(100);
    expect(api.getPanel("design")?.group.minimumWidth).toBe(100);
    expect(api.getPanel("compositions")?.group.width).toBe(100);
    expect(api.getPanel("design")?.group.width).toBe(100);
    expect(api.getPanel("preview")?.group.minimumWidth).toBe(360);
  });

  it("keeps the preview comfortable at a mid width and shrinks the sides instead", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    applySideMinimums(api, 600);
    expect(api.getPanel("preview")?.group.minimumWidth).toBe(360);
    expect(api.getPanel("compositions")?.group.minimumWidth).toBe(120);
  });

  it("moves the preview floor down rather than overflowing below 600px", () => {
    /*
     * The whole point of deriving the floors: a 420px window must produce a 420px layout.
     * With constants it produced a 600px layout inside a 420px box — a clipped column and,
     * through Electron's minimum size, an app that could not be used beside anything.
     */
    api.layout(420, 400);
    buildEditLayout(api, 420, undefined, 400);
    applySideMinimums(api, 420, 400);
    const preview = api.getPanel("preview");
    const floors = layoutFloors(420, 400);
    expect(preview?.group.minimumWidth).toBe(floors.previewWidth);
    // 420 = 220 preview + 2 × 100 side, which is dockview's own hard floor per group.
    expect(floors.previewWidth).toBe(220);
    expect(floors.sideWidth).toBe(100);
  });

  it("leaves a wide window's user-chosen widths alone", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    api.getPanel("compositions")?.group.api.setSize({ width: 300 });
    applySideMinimums(api, 1200);
    expect(api.getPanel("compositions")?.group.width).toBe(300);
  });

  it("keeps the preview's floor when a side panel is tabbed into the preview group", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    const preview = api.getPanel("preview");
    const design = api.getPanel("design");
    if (!preview || !design) throw new Error("default layout is missing panels");
    design.api.moveTo({ group: preview.group, position: "center", index: 0 });
    preview.api.setActive();
    applySideMinimums(api, 560);
    expect(preview.group.minimumWidth).toBe(360);
  });

  it("pins the preview floor when a side panel that was showing gets the preview dragged in", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    applySideMinimums(api, 560);
    const preview = api.getPanel("preview");
    const design = api.getPanel("design");
    if (!preview || !design) throw new Error("default layout is missing panels");
    preview.api.moveTo({ group: design.group });
    applySideMinimums(api, 560);
    expect(preview.group.minimumWidth).toBe(360);
  });

  it("rewrites the minimum of a group that is neither the preview nor side-only", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    const timeline = api.getPanel("timeline");
    const compositions = api.getPanel("compositions");
    if (!timeline || !compositions) throw new Error("default layout is missing panels");
    timeline.api.moveTo({ group: compositions.group });
    applySideMinimums(api, 560);
    expect(compositions.group.minimumWidth).toBe(100);
  });

  it("drops the preview floor from a group the preview has left", () => {
    api.layout(1200, 700);
    buildEditLayout(api, 1200);
    const preview = api.getPanel("preview");
    const timeline = api.getPanel("timeline");
    if (!preview || !timeline) throw new Error("default layout is missing panels");
    preview.api.moveTo({ group: timeline.group });
    applySideMinimums(api, 560);
    preview.api.moveTo({ position: "right", group: api.getPanel("design")?.group });
    applySideMinimums(api, 560);
    expect(timeline.group.minimumWidth).toBe(100);
  });

  it("gives the timeline a vertical floor that fits the window", () => {
    api.layout(1200, 400);
    buildEditLayout(api, 1200, undefined, 400);
    applySideMinimums(api, 1200, 400);
    expect(api.getPanel("timeline")?.group.minimumHeight).toBeLessThanOrEqual(400);
  });

  it("does not raise a side column's vertical floor", () => {
    /*
     * Columns are measured horizontally; their height is the dock's. dockview itself
     * applies a 100px default to every group, so the assertion is that this code adds
     * nothing on top of it — a taller floor here would make the whole dock unable to
     * shrink, which is the bug this file exists to prevent.
     */
    api.layout(1200, 400);
    buildEditLayout(api, 1200, undefined, 400);
    applySideMinimums(api, 1200, 400);
    expect(api.getPanel("compositions")?.group.minimumHeight).toBeLessThanOrEqual(100);
  });

  it("derives the preview floor's height from the window, not a constant", () => {
    // The vertical half of "the window cannot get smaller": with a constant 200 the
    // preview refused to give ground no matter how short the window became.
    api.layout(860, 280);
    buildEditLayout(api, 860, undefined, 280);
    applySideMinimums(api, 860, 280);
    expect(api.getPanel("preview")?.group.minimumHeight).toBe(layoutFloors(860, 280).previewHeight);
    expect(layoutFloors(860, 280).previewHeight).toBeLessThan(200);
  });
});
