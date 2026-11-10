/**
 * The toolbar's secondary panel: a compact slab that grows **out of the toolbar's side**.
 *
 * ## It is part of the toolbar, not a layer above it
 *
 * The panel is a **child of the toolbar element**, absolutely positioned just outside its
 * edge. That choice does three things at once:
 *
 * 1. **It follows the toolbar.** The toolbar can be dragged, and a panel that is part of
 *    its subtree moves with it for free. An earlier version was a body-level portal placed
 *    by measuring rectangles, so dragging the toolbar left the panel behind — the panel
 *    "did not follow", which is exactly what the user saw.
 * 2. **It adds no stacking layer.** It is painted in the toolbar's own stacking context,
 *    so it cannot float above things the toolbar does not float above.
 * 3. **It cannot be clipped by the scrolling tool column**, because it is a sibling of
 *    that column rather than a child of it.
 *
 * ## Which side it opens on
 *
 * The side with room: the toolbar is measured against the middle of the window each time
 * it moves, so a toolbar in the left half opens its panel to the right and vice versa.
 * The rule is one function (`submenuSide`), so every panel agrees.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { layoutViewport } from "./uiScale.js";

export type SubmenuSide = "left" | "right";

/** Gap between the toolbar edge and the panel, in pixels. */
const OFFSET = 4;

/**
 * Which side of the toolbar a panel opens on.
 *
 * Pure and exported so the rule is testable without a DOM: the panel goes where there is
 * room, not where it was first designed to go.
 */
export function submenuSide(dockCenterX: number, viewportWidth: number): SubmenuSide {
  return dockCenterX < viewportWidth / 2 ? "right" : "left";
}

export interface DockSubmenuProps {
  /**
   * The control the panel belongs to.
   *
   * Used only for its **vertical** position: the panel is centred on the control so it
   * reads as a child of that row rather than of the whole toolbar.
   */
  readonly anchor: HTMLElement | null;
  /** Width in pixels. Panels are narrow by default — they hold one row of choices. */
  readonly width?: number;
  /** Identifies the panel for tests and styling. */
  readonly overlay: string;
  readonly label: string;
  /**
   * The toolbar's position, watched so the side is re-decided **while it is dragged**.
   *
   * The panel is a child of the toolbar, so it moves with it automatically. The **side**
   * does not: it is a decision, and a decision taken once at mount stays wrong the moment
   * the toolbar crosses the middle of the window. Passing the position in makes each drag
   * step re-run the decision, which is what "switch sides at the right moment" means.
   */
  readonly dockPosition?: { readonly left: number; readonly top: number };
  readonly children: ReactNode;
}

export function DockSubmenu(props: DockSubmenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number } | null>(null);
  const [side, setSide] = useState<SubmenuSide>("left");

  /**
   * Place the panel next to its control.
   *
   * Only the vertical offset needs measuring: the horizontal side is a CSS rule
   * (`left: 100%` / `right: 100%`), so it needs no arithmetic and cannot drift. The
   * vertical offset is measured against the **toolbar root**, which is the panel's
   * containing block, so it stays correct while the toolbar is dragged.
   */
  const measure = useCallback(() => {
    const anchor = props.anchor;
    const panel = panelRef.current;
    const dock = panel?.offsetParent instanceof HTMLElement ? panel.offsetParent : null;
    if (!anchor || !panel || !dock) return;
    const anchorRect = anchor.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const panelHeight = panel.offsetHeight;
    // Centre on the control, then keep the whole panel inside the window.
    const wanted = anchorRect.top - dockRect.top + anchorRect.height / 2 - panelHeight / 2;
    const { width: viewportWidth, height: viewportHeight } = layoutViewport();
    const maxTop = viewportHeight - dockRect.top - panelHeight - 4;
    setPlacement({ top: Math.round(Math.max(0, Math.min(wanted, Math.max(0, maxTop)))) });
    /*
     * Decide from the **toolbar's current centre**, not from where it was when the panel
     * opened. The crossover point is the middle of the window: past it there is no room on
     * the right, so the panel belongs on the left.
     */
    setSide(submenuSide(dockRect.x + dockRect.width / 2, viewportWidth));
    /*
     * `dockPosition` is not read here — it is a **trigger**: any change means the toolbar
     * moved and the decision above is out of date. Reading it from the DOM instead would
     * need a poller, and the state change already fires on every drag step.
     */
    void props.dockPosition;
  }, [props.anchor, props.dockPosition]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <div
      ref={panelRef}
      role="group"
      aria-label={props.label}
      data-mystudio-overlay={props.overlay}
      data-side={side}
      style={{
        position: "absolute",
        // Out of the toolbar's flow, just past its edge — no separate layer.
        top: placement?.top ?? 0,
        ...(side === "right"
          ? { left: `calc(100% + ${OFFSET}px)` }
          : { right: `calc(100% + ${OFFSET}px)` }),
        width: props.width ?? 116,
        maxWidth: "calc(100vw - 8px)",
        padding: 4,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        borderRadius: "var(--radius-md, 8px)",
        /*
         * Tinted with the accent, so the panel reads as belonging to the control that
         * opened it — a child of the selection, not another floating window.
         */
        background: "color-mix(in oklab, var(--color-accent) 12%, var(--color-raised))",
        border: "1px solid color-mix(in oklab, var(--color-accent) 42%, var(--color-border-strong))",
        boxShadow: "0 6px 18px oklch(0 0 0 / 0.22)",
        // Opacity lets the toolbar's own pointer handling pass; the panel is not draggable
        // and must not start a drag.
        pointerEvents: "auto",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.children}
    </div>
  );
}
