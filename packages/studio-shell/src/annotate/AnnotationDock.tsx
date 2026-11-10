/**
 * The floating annotation toolbar (vertical).
 *
 * Colours match Studio's own:
 * - background/border from theme variables, never a home-made "close enough white";
 * - the active tool uses `--color-on` (same as the Inspector's pressed state);
 * - the destructive action (exit) needs no orange border; a dimmed icon is enough.
 *
 * **It must be movable.** Two entry points:
 * 1. an explicit **grip** at the top (a small bar plus the dotted glyph) that reads
 *    as draggable at a glance;
 * 2. pressing and dragging anywhere blank on the toolbar — but only past a 4px
 *    threshold, otherwise clicking a tool icon would be mistaken for a drag.
 *
 * Once the user drags it, the position is remembered and never overwritten by
 * automatic placement. Double-clicking the grip returns it to the default.
 *
 * ## The eraser has two depths
 *
 * A click erases what it touches. **Holding** it clears every mark at every timecode.
 * The deeper the action, the longer and more deliberate the gesture — there is no way
 * to wipe a whole project by misclicking.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DockSubmenu } from "./DockSubmenu.js";
import {
  PenColourPanel,
  PenColourTrigger,
  PenWidthPanel,
  PenWidthTrigger,
} from "./PenPicker.js";
import type { PenStyle } from "./penStyle.js";
import type { AnnotationTool } from "./editorState.js";
import { TOOL_COMMANDS, type CommandId } from "./commands.js";
import {
  clampDockPosition,
  isBeyondDragThreshold,
  positionAfterDrag,
  type DockPosition,
} from "./dockPosition.js";
import { ERASE_HOLD_MS } from "./eraser.js";
import { ANNOTATION_LAYERS } from "./layers.js";
import { layoutViewport, subscribeUiScale, uiScale } from "./uiScale.js";

const TOOLS: ReadonlyArray<{
  tool: AnnotationTool;
  label: string;
  glyph: string;
  hint: string;
}> = [
  { tool: "region", label: "Region", glyph: "▭", hint: "Drag out a region" },
  { tool: "arrow", label: "Arrow", glyph: "↗", hint: "Drag from an element to a target" },
  { tool: "freehand", label: "Freehand", glyph: "✎", hint: "Draw freely" },
  { tool: "eraser", label: "Eraser", glyph: "⌫", hint: "Click to erase · hold to clear every mark" },
  { tool: "select", label: "Select", glyph: "⊹", hint: "No annotation tool" },
];

const STORAGE_KEY = "mystudio:dock:position";

/**
 * The toolbar's width with no page list.
 *
 * Used only before the real width has been measured — `clampPosition` prefers the live
 * `offsetWidth`, because the toolbar grows leftwards while the board is showing.
 */
const DOCK_COLLAPSED_WIDTH = 38;

function readStoredPosition(): DockPosition | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const left = record["left"];
    const top = record["top"];
    if (typeof left !== "number" || typeof top !== "number") return null;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}

function persistPosition(position: DockPosition): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Storage unavailable: it just will not be remembered.
  }
}

/** Clamp a position into the current viewport (rules live in `dockPosition.ts`). */
function clampPosition(position: DockPosition, height: number, width: number): DockPosition {
  if (typeof window === "undefined") return position;
  return clampDockPosition(
    position,
    height,
    /*
     * The layer's own coordinates, not the window's: the overlay is rendered inside a
     * container that is scaled with a transform, so at 150% there is only 2/3 as much room
     * in the units this toolbar lays itself out in.
     */
    layoutViewport(),
    width,
  );
}

export interface AnnotationDockProps {
  readonly tool: AnnotationTool;
  readonly onToolChange: (tool: AnnotationTool) => void;
  readonly onExit: () => void;
  /**
   * Hold-the-eraser action: clear every mark at every timecode.
   *
   * Separate from the tool switch: holding a tool button is a distinct gesture from
   * pressing it, and the two must not be confused.
   */
  readonly onEraseHold: () => void;
  /** Undo the newest mark; bound blocks turn red instead of disappearing. */
  readonly onUndo: () => void;
  /**
   * Re-apply the last undone drawing action.
   *
   * Present as a button, not only as a shortcut: undo and redo are a pair, and offering
   * one without the other makes the feature discoverable only for users who read the
   * shortcut list. `Ctrl+Shift+Z` exists, but a keyboard chord that can only be found in
   * a settings tab is not a feature, it is a secret.
   */
  readonly onRedo: () => void;
  /** Whether anything is left to undo; greys the button out. */
  readonly canUndo: boolean;
  /** Whether anything is left to redo; greys the button out. */
  readonly canRedo: boolean;
  /** Whether the board is showing instead of the video. */
  readonly boardMode: boolean;
  /** Swap the picture for a blank page of the same size. */
  readonly onToggleBoard: () => void;
  /**
   * The pen to draw with on the **current surface**, and its setter.
   *
   * Present in both modes. A pen is a pen: thickness matters as much on footage as on
   * paper, and hiding the control on the video made it a board-only feature for no reason.
   * Each surface keeps its own pen, so the value shown is always the one in use.
   */
  readonly pen?: PenStyle;
  readonly onPenChange?: (pen: PenStyle) => void;
  /** Whether the surface behind the ink is light (paper), for the white-swatch warning. */
  readonly lightSurface?: boolean;
  /**
   * The board's page position.
   *
   * Only meaningful in board mode: on the video these numbers would describe a page the
   * user is not looking at.
   */
  readonly boardPager?: BoardPager;
  /** Go to the page before / after the current one. */
  readonly onStepBoardPage?: (delta: -1 | 1) => void;
  /** Append a blank page. The deck has no inherent limit. */
  readonly onAddBoardPage?: () => void;
  /** Clear the current board page. */
  readonly onClearBoardPage?: () => void;
  /** Whether the current board page has anything to clear. */
  readonly boardHasInk?: boolean;
  /**
   * Human-readable binding for a command, e.g. `Ctrl + Shift + 1`.
   *
   * Passed in rather than hard-coded: bindings are user-configurable, so a tooltip that
   * printed `(1)` kept claiming a bare digit long after the chord became
   * `Ctrl+Shift+1` — the toolbar and the Keys panel disagreed about the same key.
   */
  readonly keyHint?: (id: CommandId) => string;
  /** Default position (against the right edge of the stage). Unused once the user drags. */
  readonly defaultPosition: DockPosition;
  /**
   * Whether the toolbar accepts input.
   *
   * `H` decides whether this window is on screen; `A` decides whether it can be used.
   * Those are independent, so an inactive-but-visible toolbar still renders — it just
   * cannot be clicked, and only the drag handle stays live so the user can move the
   * window out of the way (the same rule the prompt panel follows).
   */
  readonly interactive: boolean;
}

/**
 * Which page the board is on, and how many there are.
 *
 * Two numbers rather than a list of pages: the control is a **pager** — previous, the
 * number, next — not one button per page. The count is the board's own page count, so it
 * grows only when the user adds a page.
 */
export interface BoardPager {
  /** 1-based number of the page currently showing. */
  readonly number: number;
  /** Total pages in the deck. Never zero: a board always has one page. */
  readonly count: number;
}

/** One arrow of the board pager. */
function PageStepButton(props: {
  readonly glyph: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-mystudio-overlay="dock-page-step"
      onClick={props.onClick}
      disabled={!props.enabled}
      title={props.label}
      aria-label={props.label}
      style={{
        width: 14,
        height: 20,
        display: "grid",
        placeItems: "center",
        padding: 0,
        borderRadius: 3,
        border: "none",
        background: "transparent",
        color: props.enabled ? "var(--color-text-2)" : "var(--color-text-off)",
        cursor: props.enabled ? "pointer" : "default",
        fontSize: 7,
        lineHeight: 1,
      }}
    >
      {props.glyph}
    </button>
  );
}

/** A small square button used by the board page controls. */
function pageButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 16,
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderRadius: "var(--radius-sm, 4px)",
    border: "none",
    background: "transparent",
    color: enabled ? "var(--color-text-2)" : "var(--color-text-off)",
    cursor: enabled ? "pointer" : "default",
    fontSize: 9,
    lineHeight: 1,
  };
}

/** Shared appearance for the undo/redo pair, so the two cannot drift apart. */
function historyButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 24,
    borderRadius: "var(--radius-sm, 4px)",
    border: "none",
    background: "transparent",
    color: enabled ? "var(--color-text-2)" : "var(--color-text-off)",
    cursor: enabled ? "pointer" : "default",
    fontSize: 13,
    lineHeight: 1,
  };
}

type OpenSubmenu = "colour" | "width" | null;

export function AnnotationDock(props: AnnotationDockProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Which optional panel is open. Pages are separate: they are not a toggle. */
  const [open, setOpen] = useState<OpenSubmenu>(null);
  const [pageTrigger, setPageTrigger] = useState<HTMLElement | null>(null);
  const [colourTrigger, setColourTrigger] = useState<HTMLElement | null>(null);
  const [widthTrigger, setWidthTrigger] = useState<HTMLElement | null>(null);
  /**
   * Which anchor the page panel uses.
   *
   * The board button when the board is showing (its own row), else the pen's row — the
   * page panel is about the sheet you are drawing on, so it belongs beside whichever
   * control represents that surface.
   */
  const pageAnchor = pageTrigger;
  /** The page panel is open for as long as the board is showing. */
  const showPages = props.boardMode && props.boardPager !== undefined;
  /**
   * A stored position is clamped **on read**, not trusted as-is.
   *
   * The stored coordinates come from whatever window size the user last dragged the
   * toolbar in. Opening the app in a narrower window (or moving it to a smaller
   * monitor) with a stored `left: 1272` puts the whole toolbar past the right edge —
   * on screen "somewhere", in practice invisible and unreachable. Clamping here means
   * a stale position can never strand the toolbar outside the window.
   */
  const [position, setPosition] = useState<DockPosition>(() => {
    const stored = readStoredPosition();
    if (!stored) return props.defaultPosition;
    return clampPosition(stored, 0, DOCK_COLLAPSED_WIDTH);
  });
  /** Whether the user placed it; once true, `defaultPosition` no longer applies. */
  const userPlaced = useRef<boolean>(readStoredPosition() !== null);
  /** Whether this gesture already passed the drag threshold. */
  const moved = useRef(false);

  // The default position is only trustworthy once the stage has been measured;
  // before that the incoming value is a placeholder.
  const defaultRef = useRef(props.defaultPosition);
  defaultRef.current = props.defaultPosition;
  useEffect(() => {
    if (userPlaced.current) return;
    setPosition(clampPosition(defaultRef.current, rootRef.current?.offsetHeight ?? 0, rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH));
  }, [props.defaultPosition.left, props.defaultPosition.top]);

  // Keep the toolbar on screen when the viewport changes.
  useEffect(() => {
    const onResize = () => setPosition((current) => clampPosition(current, rootRef.current?.offsetHeight ?? 0, rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /*
   * Re-clamp when the interface scale changes.
   *
   * Zooming does not fire a `resize`: the window is the same size, but the toolbar is laid
   * out in a coordinate space that just got smaller. Without this, 200% left the bottom of
   * the toolbar below the window edge — visible, unreachable, and only at high zoom.
   */
  const scale = useSyncExternalStore(subscribeUiScale, uiScale, () => 1);
  useEffect(() => {
    setPosition((current) =>
      clampPosition(
        current,
        rootRef.current?.offsetHeight ?? 0,
        rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH,
      ),
    );
  }, [scale]);

  /**
   * Re-clamp once mounted, when the real height is finally measurable.
   *
   * The initial clamp runs before layout, so it is limited to the width (it literally
   * does not know the height yet). This second pass corrects the vertical position
   * using the actual rendered height — and it also covers the case where the window
   * shrank between mount and first paint.
   */
  useEffect(() => {
    setPosition((current) => clampPosition(current, rootRef.current?.offsetHeight ?? 0, rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH));
  }, []);

  /**
   * Gestures all go through window listeners.
   *
   * Not `setPointerCapture`: the buttons inside handle their own pointers, and
   * capturing to the root may lose subsequent move/up (same trap as FloatingPanel).
   */
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: DockPosition;
  } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;

      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;

      // Below the threshold it is still a "click"; do not move.
      if (!moved.current) {
        if (!isBeyondDragThreshold(dx, dy)) return;
        moved.current = true;
      }

      // Dragging must track 1:1: no snapping, no acceleration.
      setPosition(clampPosition(positionAfterDrag(active.origin, dx, dy), rootRef.current?.offsetHeight ?? 0, rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH));
    };

    const onUp = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      gesture.current = null;

      if (!moved.current) return;
      userPlaced.current = true;
      setPosition((current) => {
        persistPosition(current);
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
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      gesture.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: position,
      };
      moved.current = false;
    },
    [position],
  );

  /** The browser still fires a click after a drag; cancel it so no tool is selected. */
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!moved.current) return;
    event.preventDefault();
    event.stopPropagation();
    moved.current = false;
  }, []);

  const resetPosition = useCallback(() => {
    userPlaced.current = false;
    const next = clampPosition(defaultRef.current, rootRef.current?.offsetHeight ?? 0, rootRef.current?.offsetWidth ?? DOCK_COLLAPSED_WIDTH);
    setPosition(next);
    persistPosition(next);
  }, []);

  // ── Eraser hold ─────────────────────────────────────────────────────────
  /**
   * Holding the eraser button is how the user says "not one mark — all of them".
   *
   * The timer is cancelled by pointerup, pointerleave and by starting a drag of the
   * toolbar, so only an actual press-and-wait fires it.
   */
  const holdTimer = useRef<number | null>(null);

  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  /** `base (chord)`, or just `base` when no binding label was supplied. */
  const withKey = (base: string, id: CommandId): string => {
    const chord = props.keyHint?.(id) ?? "";
    return chord ? `${base} (${chord})` : base;
  };

  const startEraseHold = useCallback(() => {
    cancelHold();
    holdTimer.current = window.setTimeout(() => {
      props.onEraseHold();
    }, ERASE_HOLD_MS);
  }, [cancelHold, props]);

  return (
    <div
      ref={rootRef}
      data-mystudio-overlay="dock"
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: 4,
        /*
         * Never taller than the window.
         *
         * The toolbar has a fixed set of controls and used to lay them all out at their
         * natural height (~430px). In a small window that ran off the bottom edge, so the
         * last controls — including the way out — could not be reached. The window is
         * allowed to be short now, so the stack scrolls instead of overflowing.
         */
        maxHeight: "calc(100vh - 8px)",
        boxSizing: "border-box",
        borderRadius: "var(--radius-lg, 10px)",
        background: "var(--color-raised)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "0 8px 24px oklch(0 0 0 / 0.28)",
        zIndex: ANNOTATION_LAYERS.dock,
        userSelect: "none",
        pointerEvents: "auto",
        // Inactive but visible: the toolbar is on screen but only the grip responds,
        // so the window can still be moved out of the way. Same rule as the prompt
        // panel — `H` owns presence, `A` owns interaction.
        opacity: props.interactive ? 1 : 0.75,
      }}
      onPointerDown={(event) => {
        // The shield and canvas must let go, or they steal the pointer mid-drag.
        event.stopPropagation();
        // Dragging is always allowed, even while inactive: moving is not "using".
        startDrag(event);
      }}
      onClickCapture={onClickCapture}
    >
      {/*
        Grip: makes "this can be dragged" explicit.
        Double-click returns it to the default (right of the stage), so a lost
        toolbar can always be recovered.
      */}
      <div
        data-mystudio-dock-handle
        title="Drag to move · double-click to reset"
        onDoubleClick={resetPosition}
        style={{
          width: 30,
          height: 14,
          display: "grid",
          placeItems: "center",
          borderRadius: "var(--radius-sm, 4px)",
          cursor: "grab",
          // The grip must be **visible**: it used to be text-muted at 0.6 opacity,
          // which vanished on light panels and nobody knew it could be dragged.
          color: "var(--color-text-2)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          touchAction: "none",
        }}
        onPointerEnter={(event) => {
          event.currentTarget.style.borderColor = "var(--color-border-strong)";
        }}
        onPointerLeave={(event) => {
          event.currentTarget.style.borderColor = "var(--color-border)";
        }}
      >
        {/* Three dots over two rows: the universal "draggable" signal, clearer than one glyph. */}
        <span
          style={{
            fontSize: 10,
            lineHeight: 1,
            letterSpacing: "1px",
            opacity: 0.85,
          }}
        >
          ⠿
        </span>
      </div>

      {/* Tools and actions. `disabled` rather than unmounting: while inactive the
          toolbar is still visible, so hiding its buttons would look like the window
          changed shape when the user pressed A. */}
      <div
        data-mystudio-overlay="dock-tools"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          // The grip stays put and the controls scroll: a transform would take the grip
          // away with them, and the grip is how a stray toolbar is recovered.
          overflowY: "auto",
          minHeight: 0,
          pointerEvents: props.interactive ? "auto" : "none",
        }}
      >
        {TOOLS.map(({ tool, label, glyph, hint }) => {
          const active = props.tool === tool;
          return (
            <button
              key={tool}
              type="button"
              title={withKey(hint, TOOL_COMMANDS[tool])}
              aria-label={label}
              aria-pressed={active}
              disabled={!props.interactive}
              onClick={() => props.onToolChange(tool)}
              onPointerDown={(event) => {
                // The eraser's second depth lives here: press and wait.
                if (tool !== "eraser") return;
                event.stopPropagation();
                startEraseHold();
              }}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              style={{
                position: "relative",
                width: 30,
                height: 28,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius-md, 6px)",
                border: "none",
                // Same pairing as Studio's Inspector pressed state: `--color-on` + `--color-accent-ink`.
                background: active ? "var(--color-on)" : "transparent",
                color: active ? "var(--color-accent-ink)" : "var(--color-text-2)",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                touchAction: "none",
              }}
            >
              {glyph}
            </button>
          );
        })}

        <div
          style={{
            width: 18,
            height: 1,
            background: "var(--color-border)",
            margin: "2px 0",
          }}
        />

        {/*
          Video / board switch.

          Its own row rather than a sixth tool: it does not change *how* you draw, it
          changes *what you are drawing on*.

          The board button also **owns the page panel**: it is the anchor, and the element
          the panel grows out of. While the board is showing the panel is open and stays
          open — the pages are not a menu to dig into, they are part of the surface.
        */}
        <button
          ref={setPageTrigger}
          type="button"
          data-mystudio-overlay="dock-board"
          onClick={props.onToggleBoard}
          disabled={!props.interactive}
          aria-pressed={props.boardMode}
          title={props.boardMode ? withKey("Back to the video", "toggleBoard") : withKey("Blank page to draw on", "toggleBoard")}
          aria-label={props.boardMode ? "Show video" : "Show whiteboard"}
          style={{
            width: 30,
            height: 22,
            display: "grid",
            placeItems: "center",
            flex: "0 0 auto",
            borderRadius: "var(--radius-sm, 4px)",
            border: "none",
            background: props.boardMode ? "var(--color-on)" : "transparent",
            color: props.boardMode ? "var(--color-accent-ink)" : "var(--color-text-2)",
            cursor: props.interactive ? "pointer" : "default",
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ▤
        </button>

        {/*
          Undo and redo as a pair, right below the tools.

          They are pressed constantly, so they earn a place in the toolbar rather than a
          menu. A pair is also the honest presentation: undo alone reads as "the app can
          only go backwards", and the shortcut for the other direction would exist without
          anything to discover it from.
        */}
        <button
          type="button"
          data-mystudio-overlay="dock-undo"
          onClick={props.onUndo}
          disabled={!props.interactive || !props.canUndo}
          title={withKey("Undo the last mark", "undo")}
          aria-label="Undo"
          style={historyButtonStyle(props.canUndo && props.interactive)}
        >
          ↺
        </button>

        <button
          type="button"
          data-mystudio-overlay="dock-redo"
          onClick={props.onRedo}
          disabled={!props.interactive || !props.canRedo}
          title={withKey("Redo the last undone mark", "redo")}
          aria-label="Redo"
          style={historyButtonStyle(props.canRedo && props.interactive)}
        >
          ↻
        </button>

        {/*
          Colour and thickness, as **two** buttons.

          They used to be one button with the thickness tucked inside the colour palette,
          which read as "weight belongs to colour" and made the more frequently used
          control the hidden one. Each opens its own compact panel beside the toolbar.
        */}
        {props.pen ? (
          <>
            <PenColourTrigger
              pen={props.pen}
              open={open === "colour"}
              disabled={!props.interactive}
              onClick={() => setOpen((current) => (current === "colour" ? null : "colour"))}
              anchorRef={setColourTrigger}
            />
            <PenWidthTrigger
              pen={props.pen}
              open={open === "width"}
              disabled={!props.interactive}
              onClick={() => setOpen((current) => (current === "width" ? null : "width"))}
              anchorRef={setWidthTrigger}
            />
          </>
        ) : null}

        {props.onClearBoardPage ? (
          <button
            type="button"
            data-mystudio-overlay="dock-board-clear"
            onClick={props.onClearBoardPage}
            disabled={!props.interactive || !props.boardHasInk}
            title="Clear this page only — the video keeps its marks"
            aria-label="Clear board page"
            style={pageButtonStyle(props.interactive && props.boardHasInk === true)}
          >
            ⌫
          </button>
        ) : null}

        {/*
          No send button here on purpose.

          Sending lives in the prompt box — the small green circle at the end of the last
          line. It was duplicated in this toolbar, and two buttons that do exactly the
          same thing make the user stop and compare them instead of writing.

          The toolbar is for *making* marks (tools, undo, eraser); the prompt box is where
          the prompt is written and sent. One action, one place.
        */}

        <button
          type="button"
          onClick={props.onExit}
          disabled={!props.interactive}
          title={withKey("Deactivate", "toggleAnnotate")}
          style={{
            width: 30,
            height: 20,
            borderRadius: "var(--radius-sm, 4px)",
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: props.interactive ? "pointer" : "default",
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/*
        The page panel.

        **Open the whole time the board is showing**, not on hover and not on click. The
        pages are part of the drawing surface while the board is up — the user turns a page
        because they want to sketch on the next sheet, and making them open a menu first
        would be a second action for the same intent.

        It goes out the side with room, decided by where the toolbar actually is, because
        the toolbar can be dragged and a panel pinned to one side eventually ends up
        outside the window (found.md F-065).
      */}
      {/*
        The panels.

        Each is a **child of the toolbar**, positioned just past its edge, so it moves with
        the toolbar and adds no stacking layer of its own. Opening a second one closes the
        first: two panels at once would be two answers to "what am I adjusting".

        Page position stays open the whole time the board is showing — it is part of the
        drawing surface, not a menu to dig into.
      */}
      {showPages && props.boardPager && pageAnchor ? (
        <DockSubmenu
          anchor={pageAnchor}
          dockPosition={position}
          width={104}
          label="Whiteboard pages"
          overlay="dock-page-panel"
        >
          <div
            data-mystudio-overlay="dock-pages"
            style={{ display: "flex", alignItems: "center", gap: 1 }}
          >
            <PageStepButton
              glyph="◀"
              label="Previous page"
              enabled={props.interactive && props.boardPager.number > 1}
              onClick={() => props.onStepBoardPage?.(-1)}
            />
            <span
              data-mystudio-overlay="dock-page-number"
              title={`Page ${props.boardPager.number} of ${props.boardPager.count}`}
              aria-live="polite"
              style={{
                flex: 1,
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
                fontSize: 10,
                color: "var(--color-text-1)",
              }}
            >
              {props.boardPager.number} / {props.boardPager.count}
            </span>
            <PageStepButton
              glyph="▶"
              label="Next page"
              enabled={props.interactive && props.boardPager.number < props.boardPager.count}
              onClick={() => props.onStepBoardPage?.(1)}
            />
            {/*
              Adding a page sits on the same row: the deck has no limit, and a second row
              for one button made the panel twice as tall as its content.
            */}
            <button
              type="button"
              data-mystudio-overlay="dock-page-add"
              onClick={props.onAddBoardPage}
              disabled={!props.interactive || !props.onAddBoardPage}
              title="Add a blank page after this one"
              aria-label="Add page"
              style={{
                width: 16,
                height: 20,
                padding: 0,
                borderRadius: 3,
                border: "none",
                background: "transparent",
                color: props.interactive ? "var(--color-text-2)" : "var(--color-text-off)",
                cursor: props.interactive ? "pointer" : "default",
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              +
            </button>
          </div>
        </DockSubmenu>
      ) : null}

      {open === "colour" && props.pen && colourTrigger ? (
        <DockSubmenu
          anchor={colourTrigger}
          dockPosition={position}
          width={132}
          label="Pen colour"
          overlay="pen-palette"
        >
          <PenColourPanel
            pen={props.pen}
            onChange={(pen) => {
              props.onPenChange?.(pen);
              setOpen(null);
            }}
            lightSurface={props.lightSurface === true}
          />
        </DockSubmenu>
      ) : null}

      {open === "width" && props.pen && widthTrigger ? (
        <DockSubmenu
          anchor={widthTrigger}
          dockPosition={position}
          width={104}
          label="Pen thickness"
          overlay="pen-width-panel"
        >
          <PenWidthPanel pen={props.pen} onChange={(pen) => props.onPenChange?.(pen)} />
        </DockSubmenu>
      ) : null}
    </div>
  );
}
