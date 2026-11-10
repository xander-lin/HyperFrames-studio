import type { Direction, DockviewApi } from "dockview-react";
import { DOCK_PANEL_COMPONENT } from "./dockLayoutSchema";
import { PANEL_DEFINITIONS, PANEL_IDS, isPanelId, type PanelId } from "./panelRegistry";

/** Comfortable preview width; above this there is no reason to give it more. */
const MIN_PREVIEW_W = 360;
/** Hard preview floor. Below this the picture is a thumbnail, not a preview. */
const MIN_PREVIEW_W_FLOOR = 160;
/** Comfortable preview height; a hard floor below that would stop the window shrinking. */
const MIN_PREVIEW_H_CEIL = 200;
const MIN_PREVIEW_H_FLOOR = 100;
const MIN_TIMELINE_H = 100;
/** Hard timeline floor: a strip of clips is still usable, nothing is not. */
const MIN_TIMELINE_H_FLOOR = 56;
/** Comfortable side column width. */
const MIN_SIDE_W = 200;
/**
 * Hard side floor.
 *
 * 100 is not an aesthetic choice: `dockview-core` refuses to make any group narrower
 * (`MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH`), so asking for less would be a floor the layout
 * cannot honour — it would report one number and enforce another. With this and a 160px
 * preview floor, three columns fit from 360px up.
 */
const MIN_SIDE_W_FLOOR = 100;
const DEFAULT_TIMELINE_H = 360;
const DEFAULT_LEFT = ["compositions", "assets", "code", "catalog"] as const;
const DEFAULT_RIGHT = ["design", "layers", "renders", "variables", "motionBlur"] as const;

/** The minimum sizes every group must obey at a given dock size. */
export interface LayoutFloors {
  /** The preview group's minimum width. */
  readonly previewWidth: number;
  /** A side column's minimum width. */
  readonly sideWidth: number;
  /** The preview group's minimum height. */
  readonly previewHeight: number;
  /** The timeline group's minimum height. */
  readonly timelineHeight: number;
}

/**
 * The floors, derived from the dock's size in **one** place.
 *
 * They used to be constants (preview 360 × 200, each side 120, timeline 100), which
 * quietly made 600 × 300 the narrowest possible layout: below that the columns could
 * not shrink any further, so the dock overflowed its own box and the right column was
 * clipped. That is a floor nobody asked for — the window was `minWidth: 1100` for the
 * same reason, and half a laptop screen was not enough to sit beside another window.
 *
 * Deriving them means the floors *move* with the window: the preview keeps its
 * comfortable size while it can, gives ground after that, and never disappears.
 * `dockHeight` defaults to infinity for callers that only know a width; that yields the
 * comfortable heights, so the horizontal behaviour can be tested on its own.
 */
export function layoutFloors(
  dockWidth: number,
  dockHeight: number = Number.POSITIVE_INFINITY,
): LayoutFloors {
  const previewWidth = Math.min(
    MIN_PREVIEW_W,
    Math.max(MIN_PREVIEW_W_FLOOR, dockWidth - 2 * MIN_SIDE_W_FLOOR),
  );
  const fair = Math.floor((dockWidth - previewWidth) / 2);
  const sideWidth = Math.min(MIN_SIDE_W, Math.max(MIN_SIDE_W_FLOOR, fair));

  /*
   * Vertical floors obey the same rule as the horizontal ones: the two of them together
   * must fit in the dock, or the timeline is pushed under the bottom edge where it cannot
   * be reached. The timeline keeps a usable strip and the preview takes the rest.
   */
  const timelineHeight = Math.min(
    MIN_TIMELINE_H,
    Math.max(MIN_TIMELINE_H_FLOOR, Math.round(dockHeight * 0.28)),
  );
  const previewHeight = Math.min(
    MIN_PREVIEW_H_CEIL,
    Math.max(MIN_PREVIEW_H_FLOOR, dockHeight - timelineHeight - 8),
  );
  return { previewWidth, sideWidth, previewHeight, timelineHeight };
}

/** Preferred side widths; when they overflow the preview's floor the right yields first, then the left. */
export function defaultSideWidths(viewportWidth: number) {
  const floor = sideMinimumWidth(viewportWidth);
  const left = Math.max(floor, Math.min(384, Math.round(viewportWidth * 0.257)));
  const right = Math.max(Math.min(280, floor), Math.min(424, Math.round(viewportWidth * 0.284)));
  const excess = left + right - Math.max(0, viewportWidth - layoutFloors(viewportWidth).previewWidth);
  if (excess <= 0) return { left, right };
  const shrunkRight = Math.max(floor, right - excess);
  return { left: Math.max(floor, left - (excess - (right - shrunkRight))), right: shrunkRight };
}

/**
 * Side groups keep MIN_SIDE_W while both fit beside the preview's floor, then shrink down to
 * MIN_SIDE_W_FLOOR. The floors come from `layoutFloors`, so the sides and the preview can
 * never disagree about how much room they are dividing.
 */
export function sideMinimumWidth(dockWidth: number): number {
  return layoutFloors(dockWidth).sideWidth;
}

function holdsPreview(group: DockviewApi["groups"][number]) {
  return group.panels.some((panel) => panel.id === "preview");
}

/** The zone of a group whose every tab is a side panel, else null. */
function sideZone(group: DockviewApi["groups"][number]): "left" | "right" | null {
  const zones = group.panels.map((panel) =>
    isPanelId(panel.id) ? PANEL_DEFINITIONS[panel.id].zone : "center",
  );
  const first = zones[0];
  const allSide = zones.every((zone) => zone !== "center");
  return allSide && first && first !== "center" ? first : null;
}

/** Idempotent; rewrites every group's minimum, since dockview keeps a constraint once set. */
export function applySideMinimums(
  api: DockviewApi,
  dockWidth = window.innerWidth,
  dockHeight = window.innerHeight,
) {
  const { previewWidth, previewHeight, sideWidth: minimumWidth, timelineHeight } = layoutFloors(
    dockWidth,
    dockHeight,
  );
  const cap = defaultSideWidths(dockWidth);
  for (const group of api.groups) {
    if (holdsPreview(group)) {
      group.api.setConstraints({ minimumWidth: previewWidth, minimumHeight: previewHeight });
      continue;
    }
    const hasTimeline = group.panels.some((panel) => panel.id === "timeline");
    group.api.setConstraints({
      minimumWidth,
      // Only the group that actually holds the timeline needs a vertical floor; giving
      // one to a side column would make the whole dock unable to get shorter than it.
      ...(hasTimeline ? { minimumHeight: timelineHeight } : {}),
    });
    const zone = sideZone(group);
    const limit = zone === "right" ? cap.right : cap.left;
    if (zone && minimumWidth < MIN_SIDE_W && group.width > limit) {
      group.api.setSize({ width: limit });
    }
  }
}

/**
 * Constraints a panel starts with, before `applySideMinimums` raises or lowers them.
 *
 * Using the contextual floors rather than constants means a panel added while the window
 * is small does not briefly force the layout back to a size the window cannot hold.
 */
function minimumSize(id: PanelId) {
  const floors = layoutFloors(window.innerWidth, window.innerHeight);
  if (id === "preview")
    return { minimumWidth: floors.previewWidth, minimumHeight: floors.previewHeight };
  if (id === "timeline") return { minimumHeight: floors.timelineHeight };
  return { minimumWidth: floors.sideWidth };
}

export function addRegisteredPanel(
  api: DockviewApi,
  id: PanelId,
  position?: { referencePanel: PanelId; direction: Direction },
) {
  return api.addPanel({
    id,
    component: DOCK_PANEL_COMPONENT,
    title: PANEL_DEFINITIONS[id].title,
    renderer: "always",
    ...minimumSize(id),
    ...(position ? { position } : {}),
  });
}

function addSideColumn(
  api: DockviewApi,
  ids: readonly PanelId[],
  panels: readonly PanelId[],
  direction: "left" | "right",
) {
  const [first, ...rest] = ids.filter((id) => panels.includes(id));
  if (!first) return undefined;
  addRegisteredPanel(api, first, { referencePanel: "preview", direction });
  for (const id of rest)
    addRegisteredPanel(api, id, { referencePanel: first, direction: "within" });
  api.getPanel(first)?.api.setActive();
  return first;
}

/** The default Edit layout: [library | preview | inspector] over a full-width timeline. */
export function buildEditLayout(
  api: DockviewApi,
  viewportWidth: number,
  panels: readonly PanelId[] = PANEL_IDS,
  viewportHeight: number = Number.POSITIVE_INFINITY,
) {
  api.clear();
  const widths = defaultSideWidths(viewportWidth);
  addRegisteredPanel(api, "preview");
  addRegisteredPanel(api, "timeline", { referencePanel: "preview", direction: "below" });
  const left = addSideColumn(api, DEFAULT_LEFT, panels, "left");
  const right = addSideColumn(api, DEFAULT_RIGHT, panels, "right");
  applySideMinimums(api, viewportWidth, viewportHeight);
  if (left) api.getPanel(left)?.group.api.setSize({ width: widths.left });
  if (right) api.getPanel(right)?.group.api.setSize({ width: widths.right });
  // A short window cannot give the timeline its default height; taking the preferred value
  // anyway would push the timeline past the bottom edge.
  const timelineHeight = Number.isFinite(viewportHeight)
    ? Math.min(DEFAULT_TIMELINE_H, Math.max(0, Math.round(viewportHeight * 0.4)))
    : DEFAULT_TIMELINE_H;
  api.getPanel("timeline")?.group.api.setSize({ height: timelineHeight });
}
