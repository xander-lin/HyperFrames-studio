/**
 * Draggable, resizable floating panel.
 *
 * Three independent responsibilities:
 * 1. **Move**: drag the title bar. Allowed while inactive too — "movable only".
 * 2. **Resize**: only while active, and **only the bottom-right** corner (notched
 *    grip, see `ResizeGrip`).
 * 3. **Input isolation**: while inactive the inner content is `pointerEvents:none`,
 *    so not even text can be selected — otherwise dragging the window would
 *    accidentally select prompt text.
 *
 * Implementation notes:
 * - **Window-level pointer listeners** instead of `setPointerCapture`: the latter
 *   receives no further events when the element itself has `pointerEvents` off.
 * - Position and size persist, so the panel does not have to be repositioned on
 *   every open.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { layoutViewport, subscribeUiScale, uiScale } from "./uiScale.js";
import { clampPanelBox, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, type PanelBox } from "./floatingPanelBox.js";

export interface FloatingPanelProps {
  /** Unique panel id, used to remember position and size. */
  readonly id: string;
  readonly defaultPosition: { x: number; y: number };
  readonly defaultWidth: number;
  readonly defaultHeight?: number;
  /** Whether inner controls accept input and resizing is allowed. Inactive means movable only. */
  readonly interactive: boolean;
  /**
   * Whether the initial position is trustworthy.
   *
   * The stage rect is only known after layout measurement; before that the incoming
   * `defaultPosition` is a placeholder. When false this component does **not**
   * remember its position, and moves to the real target once true — otherwise it
   * would be stuck at the placeholder forever.
   */
  readonly placementReady?: boolean;
  readonly title: React.ReactNode;
  readonly children: React.ReactNode;
}

type Box = PanelBox;

function storageKey(id: string): string {
  return `mystudio:panel:${id}`;
}

function readStored(id: string): Partial<Box> | null {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const box: Partial<Box> = {};
    for (const key of ["x", "y", "width", "height"] as const) {
      if (key in parsed) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) box[key] = value;
      }
    }
    return box;
  } catch {
    return null;
  }
}

/**
 * Clamp into the viewport.
 *
 * The rule itself lives in `floatingPanelBox.ts`, so the test can call the real function
 * instead of a copy next to the component.
 */
function clampBox(box: Box): Box {
  return clampPanelBox(box, layoutViewport());
}

export function FloatingPanel(props: FloatingPanelProps) {
  const [box, setBox] = useState<Box>(() => {
    const stored = readStored(props.id);
    return clampBox({
      x: stored?.x ?? props.defaultPosition.x,
      y: stored?.y ?? props.defaultPosition.y,
      width: stored?.width ?? props.defaultWidth,
      height: stored?.height ?? props.defaultHeight ?? 260,
    });
  });

  /**
   * Whether the user has already positioned or resized this panel.
   *
   * Once they have, respect it and never overwrite it with automatic placement.
   */
  const userPlaced = useRef<boolean>(readStored(props.id) !== null);

  // Move to the real default once the position is trustworthy (only if untouched).
  useEffect(() => {
    if (!props.placementReady || userPlaced.current) return;
    setBox((current) =>
      clampBox({
        ...current,
        x: props.defaultPosition.x,
        y: props.defaultPosition.y,
        width: props.defaultWidth,
      }),
    );
  }, [props.placementReady, props.defaultPosition.x, props.defaultPosition.y, props.defaultWidth]);

  // In-flight drag/resize. Kept in a ref so pointermove does not cause extra renders.
  const gesture = useRef<
    | { kind: "move"; pointerId: number; startX: number; startY: number; origin: Box }
    | { kind: "resize"; pointerId: number; startX: number; startY: number; origin: Box }
    | null
  >(null);

  const persist = useCallback(
    (next: Box) => {
      try {
        window.localStorage.setItem(storageKey(props.id), JSON.stringify(next));
      } catch {
        // Storage unavailable: it just will not be remembered.
      }
    },
    [props.id],
  );

  // Pull the panel back in when the viewport changes.
  useEffect(() => {
    const onResize = () => setBox((current) => clampBox(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /*
   * …and when the interface scale changes.
   *
   * A zoom is not a resize: the window keeps its size while the space this panel lays
   * itself out in shrinks. Without this, zooming to 200% pushed the prompt box past the
   * window edge — visible, with its send button unreachable.
   */
  const scale = useSyncExternalStore(subscribeUiScale, uiScale, () => 1);
  useEffect(() => {
    setBox((current) => clampBox(current));
  }, [scale]);

  /**
   * All gestures go through window listeners.
   *
   * Not `setPointerCapture`: while inactive the panel body is `pointerEvents:none`,
   * a captured element is excluded from hit testing, and subsequent move/up are
   * lost — the panel "moves once and stops". Listening on window is independent of
   * whether the element receives events.
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;

      if (active.kind === "move") {
        setBox(
          clampBox({
            ...active.origin,
            x: active.origin.x + (event.clientX - active.startX),
            y: active.origin.y + (event.clientY - active.startY),
          }),
        );
        return;
      }

      // Resizing only touches the bottom-right: width and height each grow with the
      // delta, clamped to the minimum.
      const { width: vw, height: vh } = layoutViewport();
      setBox(
        clampBox({
          ...active.origin,
          width: Math.max(PANEL_MIN_WIDTH, Math.min(active.origin.width + (event.clientX - active.startX), vw - active.origin.x - 8)),
          height: Math.max(PANEL_MIN_HEIGHT, Math.min(active.origin.height + (event.clientY - active.startY), vh - active.origin.y - 8)),
        }),
      );
    };

    const onUp = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      gesture.current = null;
      userPlaced.current = true;
      setBox((current) => {
        persist(current);
        return current;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [persist]);

  const startMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    gesture.current = {
      kind: "move",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: box,
    };
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: "resize",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: box,
    };
  };

  return (
    <div
      data-mystudio-overlay="float-panel"
      style={{
        position: "fixed",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        display: "flex",
        flexDirection: "column",
        // Everything from Studio's theme variables: the white background and border
        // must match the original exactly, not be a home-made "close enough white".
        borderRadius: "var(--radius-lg, 10px)",
        background: "var(--color-raised)",
        color: "var(--color-text-body)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "0 16px 44px oklch(0 0 0 / 0.35)",
        fontSize: "var(--text-step-11, 11px)",
        overflow: "hidden",
        pointerEvents: "auto",
        // Nothing in the window is selectable text; controls and labels are for
        // clicking and dragging. Input fields opt back in via `mystudio.css`.
        userSelect: "none",
      }}
    >
      {/* Drag bar: the whole strip is draggable and the cursor says so. */}
      <div
        data-mystudio-drag-handle
        onPointerDown={startMove}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          cursor: "grab",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          fontSize: "var(--text-step-10, 10px)",
          color: "var(--color-text-muted)",
          userSelect: "none",
          touchAction: "none",
          flex: "0 0 auto",
        }}
      >
        <span style={{ opacity: 0.55, letterSpacing: "-1px" }}>⠿</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.title}
        </span>
      </div>

      <div
        /*
         * Default: nothing in here is selectable.
         *
         * A panel body is mostly **controls** — buttons, chips, labels, an inspector
         * full of property rows. Dragging across them is a window gesture (move it, or
         * press a control), never "I want this text". Letting the browser smear a blue
         * selection across "Nothing selected" / "Record a gesture" looks like a bug and
         * there is nothing there worth copying.
         *
         * The exceptions are the fields the user actually types into. They are not
         * special-cased here; `mystudio.css` opts in `input` / `textarea` /
         * `contenteditable` / `[data-mystudio-selectable]` and leaves everything else
         * non-selectable.
         */
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: 8,
          // Inactive: nothing inside responds.
          pointerEvents: props.interactive ? "auto" : "none",
          userSelect: "none",
        }}
      >
        {props.children}
      </div>

      {/* Resize grip: bottom-right only, and only while active. */}
      {props.interactive ? <ResizeGrip onPointerDown={startResize} /> : null}
    </div>
  );
}

/**
 * Bottom-right resize grip.
 *
 * Drawn as a notch (two slashes) rather than the generic triangle — a triangle
 * blends into scrollbars on dark backgrounds; a notch reads as "drag here to
 * resize".
 */
function ResizeGrip(props: { onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void }) {
  return (
    <div
      data-mystudio-resize-grip
      onPointerDown={props.onPointerDown}
      title="Drag to resize"
      style={{
        position: "absolute",
        right: 0,
        bottom: 0,
        width: 14,
        height: 14,
        cursor: "nwse-resize",
        touchAction: "none",
        display: "grid",
        placeItems: "end",
        padding: 2,
        color: "var(--color-text-off)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        {/* Notch: two slashes */}
        <path d="M9 1 1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M9 5.5 5.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </div>
  );
}
