/**
 * The screen sprite.
 *
 * It replaces the old "Window" button — one line of text that told the user
 * nothing and hinted at nothing.
 *
 * The sprite does four things:
 * 1. **Hug the edge**: it does not sit on the canvas; normally it is a small tab at
 *    the border that peeks out when the pointer comes close.
 * 2. **Header switch**: tiling desktops such as niri need the whole top bar hidden.
 * 3. **Panel switches**: show/hide Studio's panels (Compositions / Preview / Design / …).
 * 4. **Shortcuts available now**: only the keys that actually work **right now**, not
 *    an exhaustive list.
 *
 * Palette: green primary, white secondary. Green comes from Studio's own
 * `--color-accent` family (the brand colour) so it matches the rest of the UI;
 * white/light is used for icons and accents. It stays legible in both themes by
 * relying on `--color-on-accent` and theme variables rather than hard-coded colours.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BRIDGE_ROUTES } from "@mystudio/protocol";
import { zoomIn, zoomOut, zoomReset, type ZoomTarget } from "./uiScale.js";
import { requestOpenProject } from "./openProject.js";
import {
  getHeaderActions,
  subscribeHeaderActions,
  type HeaderActions,
} from "./headerActions.js";
import { ANNOTATION_LAYERS } from "./layers.js";
import type { SpriteShortcut } from "./spriteShortcuts.js";
import type { PanelId } from "../components/dock/panelRegistry.js";

/** Re-exported so callers have one import for the sprite and the row type. */
export type { SpriteShortcut } from "./spriteShortcuts.js";

/** What the host reports about the open project. */
export interface ProjectInfo {
  /** Display name, e.g. the manifest's title. */
  readonly name: string;
  /** Absolute path, shown in full because it is the thing the user needs. */
  readonly dir: string;
}

/** Subscribe to the header actions: hiding the header must not lose the features. */
function useHeaderActions(): HeaderActions | null {
  return useSyncExternalStore(subscribeHeaderActions, getHeaderActions, () => null);
}

/**
 * One top-level panel, as the sprite lists it.
 *
 * `id` is a `PanelId` rather than `string`: the sprite's list is built from the dock's own
 * registry, and the caller hands the id straight back to it. A `string` here would force
 * an assertion at that boundary — exactly where a typo should be a compile error.
 */
export interface SpritePanel {
  readonly id: PanelId;
  readonly title: string;
  readonly open: boolean;
}

export type SpriteEdge = "right" | "left" | "bottom";

export interface ScreenSpriteProps {
  /** Which edge it hugs. */
  readonly edge: SpriteEdge;
  /** Shortcuts available right now. An empty array means nothing is pressable. */
  readonly shortcuts: readonly SpriteShortcut[];
  /** Studio panels and whether they are open. */
  readonly panels: readonly SpritePanel[];
  readonly onTogglePanel: (id: PanelId) => void;
  readonly onResetLayout?: () => void;
  /** Whether the header is shown; when hidden, the sprite takes over its features. */
  readonly chromeVisible: boolean;
  readonly onToggleChrome: () => void;
  /**
   * The project currently open, as the host reported it.
   *
   * Shown because a desktop app that opened a directory must be able to say **which** one.
   * Without it, switching projects is a guess: the window looks the same either way, and
   * the only clue is the content. `null` means "not known yet", which is different from
   * "no project".
   */
  readonly project?: ProjectInfo | null;
  /** Ask the host for a different project. */
  readonly onOpenProject?: () => void;
  /**
   * Which surface the zoom rows resize.
   *
   * The same rule the chord follows (`zoomTargetFor`): while this layer has the keyboard,
   * its chrome is what grows; otherwise the editor is. Passing it in rather than reading a
   * global keeps the sprite a presentational component.
   */
  readonly zoomTarget?: ZoomTarget;
  /**
   * The key-binding editor.
   *
   * Passed in as a node rather than as props-plus-callbacks: the sprite is about layout
   * and appearance, and stuffing a settings form's whole state into it would make the
   * two impossible to change independently.
   */
  readonly keybindings?: React.ReactNode;
  /**
   * Which OpenCode conversation this project delivers to.
   *
   * Also a node, for the same reason as `keybindings` — and because the picker needs its
   * own fetch/refresh lifecycle, which does not belong in a component about layout.
   */
  readonly conversation?: React.ReactNode;
}

/** How close to the edge the pointer must be before it peeks out. */
const PEEK_DISTANCE = 16;

/** Primary green. Studio's brand green, not a new one. */
const ACCENT = "var(--color-accent, #37b878)";
const ON_ACCENT = "var(--color-on-accent, #ffffff)";

export function ScreenSprite(props: ScreenSpriteProps) {
  const zoomTo: ZoomTarget = props.zoomTarget ?? "studio";
  const [open, setOpen] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("interface");
  const rootRef = useRef<HTMLDivElement>(null);
  const header = useHeaderActions();

  // Peek out half a body when the pointer approaches the edge, so the user knows it is there.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const near =
        props.edge === "right"
          ? window.innerWidth - event.clientX <= PEEK_DISTANCE
          : props.edge === "left"
            ? event.clientX <= PEEK_DISTANCE
            : window.innerHeight - event.clientY <= PEEK_DISTANCE;
      setPeeking(near);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [props.edge]);

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const revealed = open || peeking;
  const offset = revealed ? 0 : 5;

  return (
    <div
      ref={rootRef}
      data-mystudio-overlay="sprite"
      style={{
        position: "fixed",
        zIndex: ANNOTATION_LAYERS.sprite,
        ...(props.edge === "right"
          ? { right: -offset, top: "50%", transform: "translateY(-50%)" }
          : props.edge === "left"
            ? { left: -offset, top: "50%", transform: "translateY(-50%)" }
            : { bottom: -offset, left: "50%", transform: "translateX(-50%)" }),
        transition: "right 160ms ease, left 160ms ease, bottom 160ms ease",
        display: "flex",
        flexDirection: props.edge === "bottom" ? "column-reverse" : "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      {/* The body: solid green, white icon. Buttons sit **in a row** — a vertical
          stack would suggest more is hidden below and force scrolling to find out. */}
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label="Screen sprite: panels, tools and shortcuts"
          title="Panels, tools and available shortcuts"
          style={{
            width: 32,
            height: 32,
            display: "grid",
            placeItems: "center",
            border: "1px solid color-mix(in oklab, " + ACCENT + " 70%, black)",
            borderRadius: 999,
            background: ACCENT,
            color: ON_ACCENT,
            cursor: "pointer",
            boxShadow: "0 4px 16px color-mix(in oklab, " + ACCENT + " 45%, transparent)",
            padding: 0,
            transition: "transform 160ms ease",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          {/* Rounded triangle: the same shape language as the Hyperframes play badge. */}
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M8 4.8c0-2 2.2-3.2 3.9-2.1l9 5.9c1.6 1 1.6 3.3 0 4.3l-9 5.9C10.2 19.9 8 18.7 8 16.7z"
              fill="currentColor"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open ? (
        <div
          role="dialog"
          aria-label="Panels, tools and shortcuts"
          style={{
            width: 268,
            maxHeight: "calc(100vh - 96px)",
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            border: "1px solid var(--color-border, rgba(127,127,127,0.3))",
            background: "var(--color-raised, rgba(24,24,28,0.97))",
            color: "var(--color-text-body, inherit)",
            boxShadow: "0 18px 46px rgba(0,0,0,0.45)",
            backdropFilter: "blur(16px)",
            fontSize: 12,
            overflow: "hidden",
          }}
        >
          {/* Three side-by-side tabs: see everything at once, no scrolling to discover. */}
          <div
            role="tablist"
            style={{
              display: "flex",
              gap: 2,
              padding: 3,
              borderBottom: "1px solid var(--color-border, rgba(127,127,127,0.25))",
            }}
          >
            {TABS.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    flex: 1,
                    padding: "5px 0",
                    border: "none",
                    borderRadius: 7,
                    background: selected ? ACCENT : "transparent",
                    color: selected ? ON_ACCENT : "var(--color-text-2, inherit)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: selected ? 600 : 400,
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div style={{ overflowY: "auto", padding: 8 }}>
            {activeTab === "interface" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {/*
                  Which project is open, in full.
                  A desktop app that opens a directory has to be able to say which one;
                  otherwise "switch project" is a jump into the dark.
                */}
                <div
                  data-mystudio-overlay="sprite-project"
                  title={props.project ? `${props.project.name}\n${props.project.dir}` : "No project open"}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    padding: "4px 6px",
                    marginBottom: 2,
                    borderRadius: 6,
                    background: "color-mix(in oklab, " + ACCENT + " 8%, transparent)",
                    border: "1px solid color-mix(in oklab, " + ACCENT + " 22%, transparent)",
                  }}
                >
                  <span style={{ fontSize: 10, fontWeight: 600, lineHeight: 1.4 }}>
                    {props.project?.name ?? "No project"}
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      lineHeight: 1.4,
                      color: "var(--color-text-3)",
                      // The path is the useful part, and it is long: break it rather than
                      // clipping the end, where the project's own name lives.
                      wordBreak: "break-all",
                    }}
                  >
                    {props.project?.dir ?? "—"}
                  </span>
                </div>
                <Row
                  onClick={() => (props.onOpenProject ? props.onOpenProject() : void requestOpenProject())}
                  tick={false}
                  icon="⊞"
                  label="Open project…"
                  title="Pick a project folder, or a folder whose subfolders are projects"
                />
                {/*
                  The conversation this project delivers to.

                  Placed above the appearance settings because it is the one item here that
                  changes where work **goes**, not how it looks. Unbound, it names the
                  session the last prompt actually reached, so a wrong guess is visible.
                */}
                {props.conversation ?? null}
                <Row
                  onClick={props.onToggleChrome}
                  tick={!props.chromeVisible}
                  icon={null}
                  label="Hide top bar"
                  title="Hide the header toolbar and give the space back to the canvas"
                />
                {header ? (
                  <ThemeRow isDark={header.isDark} onToggle={header.toggleTheme} />
                ) : null}
                {/*
                  Zoom rows follow the same routing as the chord: the surface that owns the
                  input is the one that grows. Saying which is explicit in the row's title,
                  because "zoom" alone no longer has one meaning in this window.
                */}
                <Row
                  onClick={() => void zoomIn(zoomTo)}
                  tick={false}
                  icon="+"
                  label={zoomTo === "layer" ? "Zoom annotator in" : "Zoom editor in"}
                  title={`Ctrl + = · ${zoomTo === "layer" ? "this annotation layer" : "Studio"}`}
                  trailing="Ctrl +"
                />
                <Row
                  onClick={() => void zoomOut(zoomTo)}
                  tick={false}
                  icon="−"
                  label={zoomTo === "layer" ? "Zoom annotator out" : "Zoom editor out"}
                  title={`Ctrl + - · ${zoomTo === "layer" ? "this annotation layer" : "Studio"}`}
                  trailing="Ctrl -"
                />
                <Row
                  onClick={() => void zoomReset(zoomTo)}
                  tick={false}
                  icon="↺"
                  label={zoomTo === "layer" ? "Reset annotator zoom" : "Reset editor zoom"}
                  title={`Ctrl + 0 · ${zoomTo === "layer" ? "this annotation layer" : "Studio"}`}
                  trailing="Ctrl 0"
                />
              </div>
            ) : null}

            {activeTab === "tools" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {header ? (
                  <>
                    <a
                      href={header.capture.href}
                      download={header.capture.filename}
                      onFocus={header.capture.refreshTime}
                      onPointerDown={header.capture.refreshTime}
                      onClick={(event) => header.capture.onClick(event)}
                      aria-disabled={header.capture.capturing || undefined}
                      style={{
                        ...rowStyle,
                        textDecoration: "none",
                        opacity: header.capture.capturing ? 0.5 : 1,
                        cursor: header.capture.capturing ? "default" : "pointer",
                      }}
                      title="Save the current frame as an image"
                    >
                      <span style={{ width: 13, color: ACCENT }}>⌾</span>
                      <span style={{ flex: 1, textAlign: "left" }}>Capture frame</span>
                    </a>
                    <Row
                      onClick={header.toggleInspector}
                      tick={header.inspectorActive}
                      icon={null}
                      label="Inspector"
                      title="Show or hide the design panel"
                    />
                    <Row
                      onClick={header.onExport}
                      tick={false}
                      icon="⇩"
                      label={header.exporting ? "Rendering…" : "Export"}
                      title={
                        header.ffmpegMissing
                          ? "FFmpeg is missing — opens the Renders panel with the install command"
                          : "Render and export this composition"
                      }
                      disabled={header.exportDisabled}
                    />
                  </>
                ) : null}
              </div>
            ) : null}

            {activeTab === "keys" ? props.keybindings ?? null : null}

            {activeTab === "panels" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {props.panels.map((panel) => (
                  <Row
                    key={panel.id}
                    onClick={() => props.onTogglePanel(panel.id)}
                    tick={panel.open}
                    icon={null}
                    label={panel.title}
                    title={panel.title}
                  />
                ))}
                {props.onResetLayout ? (
                  <Row
                    onClick={() => {
                      props.onResetLayout?.();
                    }}
                    tick={false}
                    icon={null}
                    label="Reset layout"
                    title="Restore the default panel layout"
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Shortcuts available now: only those that actually work. */}
          <div
            style={{
              borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))",
              padding: "6px 8px 8px",
              maxHeight: 168,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: 0.4,
                opacity: 0.45,
                padding: "2px 0 4px",
                textTransform: "uppercase",
              }}
            >
              {props.shortcuts.length > 0 ? "Available now" : "No shortcuts right now"}
            </div>
            {props.shortcuts.length > 0 ? (
              <div style={{ display: "grid", gap: 1 }}>
                {props.shortcuts.map((shortcut) => (
                  <div
                    // A key can appear twice with different meanings (zoom in two modes),
                    // so the row identity is key + label rather than the key alone.
                    key={`${shortcut.key}:${shortcut.label}`}
                    title={shortcut.detail}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "3px 2px",
                      cursor: "help",
                    }}
                  >
                    <kbd style={kbdStyle}>{shortcut.key}</kbd>
                    <span style={{ flex: 1, opacity: 0.8 }}>{shortcut.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.5, padding: "2px", lineHeight: 1.6 }}>
                No shortcuts apply in the current context.
              </div>
            )}
          </div>

          {/* A frameless window on a tiling desktop has no system close button, so
              the app must offer an exit. */}
          <div
            style={{
              borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))",
              padding: 4,
            }}
          >
            <Row
              onClick={() => void fetch(BRIDGE_ROUTES.quit, { method: "POST" }).catch(() => undefined)}
              tick={false}
              icon="⊗"
              label="Quit"
              title="Quit MyStudio"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const TABS = [
  { id: "interface", label: "Interface" },
  { id: "tools", label: "Tools" },
  { id: "panels", label: "Panels" },
  { id: "keys", label: "Keys" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Theme switch row.
 *
 * The icons are Studio's own sun/moon SVGs, visually identical to the header's
 * ThemeToggle — not a second set, so there are never two kinds of "moon".
 */
function ThemeRow(props: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      style={rowStyle}
      title={props.isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <span
        style={{
          width: 13,
          height: 13,
          display: "grid",
          placeItems: "center",
          color: "var(--color-accent-ink, #2f7d55)",
        }}
      >
        {props.isDark ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </span>
      <span style={{ flex: 1, textAlign: "left", opacity: 0.85 }}>
        {props.isDark ? "Light theme" : "Dark theme"}
      </span>
    </button>
  );
}

/** Generic row: tick / icon / label / trailing hint. */
function Row(props: {
  onClick: () => void;
  tick: boolean;
  icon: string | null;
  label: string;
  title?: string;
  trailing?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      style={{ ...rowStyle, opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon ? (
        <span style={{ width: 13, color: "var(--color-accent-ink, #2f7d55)", textAlign: "center" }}>
          {props.icon}
        </span>
      ) : (
        <Tick on={props.tick} />
      )}
      <span style={{ flex: 1, textAlign: "left" }}>{props.label}</span>
      {props.trailing ? (
        <span style={{ opacity: 0.35, fontSize: 10 }}>{props.trailing}</span>
      ) : null}
    </button>
  );
}

function Tick(props: { on: boolean }) {
  return (
    <span
      style={{
        width: 13,
        // `accent-ink` is "accent-coloured text on a surface"; in the light theme it
        // darkens. A plain `accent` is too pale on white and nearly invisible.
        color: "var(--color-accent-ink, #2f7d55)",
        opacity: props.on ? 1 : 0,
        fontWeight: 700,
      }}
    >
      ✓
    </span>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 4px",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
};

const kbdStyle: React.CSSProperties = {
  minWidth: 18,
  padding: "1px 5px",
  borderRadius: 4,
  border: "1px solid color-mix(in oklab, " + ACCENT + " 40%, transparent)",
  background: "color-mix(in oklab, " + ACCENT + " 12%, transparent)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 10,
  textAlign: "center",
  lineHeight: 1.5,
};
