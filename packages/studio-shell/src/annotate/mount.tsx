/**
 * Annotation layer mount point — the only place in this fork that touches upstream.
 *
 * Interaction model:
 *
 * One **resident window** with three independent axes:
 * - `H` visibility: whether the window is on screen. Nothing else.
 * - `A` activation: once active it **fully captures** input; Studio underneath stops responding.
 * - drag: while inactive the window stays visible and can be moved; all other input is swallowed to prevent accidents.
 *
 * Plus `Ctrl+E` (property float), `Ctrl+Shift+1..5` (tool switch), `Ctrl+S` (insert
 * the annotation into the prompt box) and `Ctrl+B` (blank page). The binding table
 * lives in `commands.ts`; every key is user-configurable and every one has a mouse
 * entry point.
 *
 * **It never occupies layout**: no padding, no sidebar. The window floats over the
 * picture, and layout visibility is delegated to the screen sprite docked at the
 * edge.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { HostConfig } from "@mystudio/protocol";
import {
  MOUSE_ONLY_POLICY,
  installShortcutPolicy,
  installShortcutPolicyOnFrame,
  type ShortcutHandlers,
} from "./shortcutPolicy.js";
import { COMMANDS, RESERVED_KEYS, type CommandId } from "./commands.js";
import { formatBinding, matches, type Binding, type KeyBinding, type KeyEventLike } from "./keybinding.js";
import { findConflict, loadKeymap, resolveKeymap, saveKeymap, type ResolvedKeymap } from "./keymapStore.js";
import { KeybindingsPanel } from "./KeybindingsPanel.js";
import { SubscriberPanel } from "./SubscriberPanel.js";
import { loadHostConfig } from "./hostBridge.js";
import { usePreviewIframeStore } from "../player/store/previewIframeStore";
import { usePlayerStore } from "../player";
import { useStudioShellContextOptional } from "../contexts/StudioContext";
import { useDomEditSelectionContextOptional } from "../contexts/DomEditContext";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import {
  PANEL_DEFINITIONS,
  TOP_LEVEL_PANELS,
  type PanelId,
} from "../components/dock/panelRegistry";
import { AnnotationCanvas } from "./AnnotationCanvas.js";
import { newestReferenceable } from "./annotationView.js";
import { toElementTarget, type SelectionLike } from "./elementCapture.js";
import { useBoard } from "./useBoard.js";
import {
  pageNumberOf,
  useBoardStore,
} from "./boardStore.js";
import { BOARD_PAPER, DEFAULT_PEN, type PenStyle } from "./penStyle.js";
import { requestOpenProject } from "./openProject.js";
import { AnnotationDock, type BoardPager } from "./AnnotationDock.js";
import { PromptComposer } from "./PromptComposer.js";
import { FloatingPanel } from "./FloatingPanel.js";
import { ScreenSprite } from "./ScreenSprite.js";
import { spriteShortcuts } from "./spriteShortcuts.js";
import { useAnnotations } from "./useAnnotations.js";
import {
  measureStage,
  sameStageRect,
  type PreviewStageRect,
} from "./stageMetrics.js";
import { dockDefaultPosition, promptPlacement } from "./promptPlacement.js";
import {
  INITIAL_SURFACE,
  capturesInput,
  setEditorTarget,
  toggleActive,
  toggleEditor,
  toggleVisible,
  type SurfaceState,
} from "./surfaceMode.js";
import { borrowDesignPanel, restoreDesignPanel } from "./inspectorBridge.js";
import {
  shouldHandleEditorKey,
  useFullscreenElement,
  useOverlayHost,
} from "./fullscreen.js";
import {
  handleZoomKey,
  layoutViewport,
  restoreUiScale,
  subscribeUiScale,
  uiScale,
  zoomTargetFor,
} from "./uiScale.js";
import { releaseStudioKeys, studioConflict } from "./studioConflict.js";
import { suspendStudio } from "./studioSuspend.js";
import { installSelectionGuard } from "./selectionGuard.js";
import { cursorForShield } from "./cursors.js";
import { releaseFieldFocus } from "./focusRelease.js";
import { describeOutcome } from "./deliveryLabel.js";
import { subscribeIframeReload } from "./iframeReload.js";
import { ANNOTATION_LAYERS } from "./layers.js";

export function MyStudioOverlay() {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [configNote, setConfigNote] = useState<string | null>(null);
  const [stageRect, setStageRect] = useState<PreviewStageRect | null>(null);
  const [surface, setSurface] = useState<SurfaceState>(INITIAL_SURFACE);
  const [inspectorUnavailable, setInspectorUnavailable] = useState(false);
  /**
   * Whether the video is actually fullscreen, and where the overlay should mount.
   *
   * These must be handled together: in fullscreen the browser **paints only the
   * fullscreen element's subtree**, so an annotation layer on `document.body`
   * "exists but is invisible". `useOverlayHost` returns a container inside the
   * fullscreen element while fullscreen and `body` after.
   */
  const fullscreenElement = useFullscreenElement();
  const overlayHost = useOverlayHost();
  /** Fullscreen state for the long-lived shortcut callback (cannot close over state). */
  const fullscreenRef = useRef<Element | null>(null);
  fullscreenRef.current = fullscreenElement;
  /**
   * Whether the header is shown.
   *
   * Default **hidden**: this is a desktop app whose window already has a title bar;
   * on a tiling desktop like niri another 40px toolbar is pure wasted space. Every
   * function lives in the sprite and can be recalled at any time.
   */
  const [chromeVisible, setChromeVisible] = useState(() => {
    try {
      const stored = window.localStorage.getItem("mystudio:chrome");
      return stored === null ? false : stored === "visible";
    } catch {
      return false;
    }
  });

  // Toggle with an attribute instead of unmounting the header: its actions must
  // stay available (see headerActions.ts).
  useEffect(() => {
    const root = document.documentElement;
    if (chromeVisible) root.removeAttribute("data-mystudio-chrome");
    else root.dataset.mystudioChrome = "hidden";
    try {
      window.localStorage.setItem("mystudio:chrome", chromeVisible ? "visible" : "hidden");
    } catch {
      // Storage unavailable: use the session default.
    }
  }, [chromeVisible]);

  const previewIframe = usePreviewIframeStore((s) => s.iframe);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const shell = useStudioShellContextOptional();
  const domEdit = useDomEditSelectionContextOptional();

  // Studio's layout state: handed to the sprite to display and toggle.
  const openPanels = useDockLayoutStore((s) => s.openPanels);
  const panelIds = useDockLayoutStore((s) => s.panels);
  const togglePanel = useDockLayoutStore((s) => s.togglePanel);
  const resetLayout = useDockLayoutStore((s) => s.resetLayout);
  const activatePanel = useDockLayoutStore((s) => s.activatePanel);

  const compositionWidth = shell?.compositionDimensions?.width ?? null;
  const compositionHeight = shell?.compositionDimensions?.height ?? null;

  // Restore the last interface scale at startup.
  useEffect(() => {
    restoreUiScale();
  }, []);

  /**
   * The layer's own scale.
   *
   * `Ctrl` `+`/`-`/`0` used to resize only Studio: every control in this overlay is sized
   * in pixels (so it stays legible over footage), and pixels do not follow a root font
   * size. The result was a toolbar that could never be made bigger or smaller — the one
   * part of the app the user actually looks at while annotating.
   */
  const scale = useSyncExternalStore(subscribeUiScale, uiScale, () => 1);

  /*
   * Take ownership of the chords this layer uses, at mount.
   *
   * Studio registers its hotkey listener once and early; this layer's listener is
   * re-registered whenever the preview iframe changes, so it ends up behind Studio's and
   * `stopImmediatePropagation` arrives too late — both actions run for one press. Rather
   * than fight for the event, the keys Studio must not also use are handed to other
   * chords, so there is one owner per combination.
   *
   * Restored on unmount: the takeover belongs to this layer's lifetime, not to the page.
   */
  useEffect(() => releaseStudioKeys(), []);

  // ── Host config ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void loadHostConfig().then((result) => {
      if (cancelled) return;
      if (result.kind === "ready") {
        setConfig(result.config);
        setConfigNote(null);
      } else {
        setConfig(null);
        setConfigNote(result.reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Computed before the hook so the hook can decide whether it owns the keyboard.
  const capturing = capturesInput(surface);

  /*
   * While this layer owns the keyboard, Studio is made **non-interactive**, not merely ignored.
   *
   * The two states must be two applications that cannot affect each other. Blocking key events
   * at the top of the chain cannot deliver that (the editor is the event's target and would stop
   * receiving characters), and relying on Studio's handlers to skip text fields is luck: 16 of
   * its 38 keydown listeners have no such guard. `inert` is the browser's own statement that a
   * subtree is not interactive, so it does not depend on anyone's care (found.md F-125).
   *
   * The annotation surface is a **sibling** of Studio's root under `<body>`, so this does not
   * disable this layer's own toolbar or prompt box.
   */
  useLayoutEffect(() => {
    if (!capturing) return;
    return suspendStudio();
  }, [capturing]);

  /*
   * The board page on screen, read **before** the hook so the hook can be told what the paper
   * is. Declared here rather than further down because `useAnnotations` needs it: the request
   * has to know that Ctrl+S means "this page" while the board is showing (found.md F-128).
   */
  const boardModeEarly = useBoardStore((state) => state.mode);
  const boardPagesEarly = useBoardStore((state) => state.pages);
  const boardCurrentEarly = useBoardStore((state) => state.current);
  const boardSurface = useMemo(
    () =>
      boardModeEarly === "board"
        ? {
            key: boardCurrentEarly,
            marks: boardPagesEarly.find((page) => page.key === boardCurrentEarly)?.marks ?? [],
            background: BOARD_PAPER,
          }
        : null,
    [boardModeEarly, boardPagesEarly, boardCurrentEarly],
  );

  const annotations = useAnnotations({
    config,
    stageRect,
    currentTime,
    activeCompPath: shell?.activeCompPath ?? null,
    compositionWidth,
    compositionHeight,
    previewIframe,
    annotating: capturing,
    board: boardSurface,
  });

  // ── Whiteboard ──────────────────────────────────────────────────────────

  /** "board" shows the page; "video" shows the picture. */
  const boardMode = useBoardStore((state) => state.mode);
  /**
   * The pen used on the video.
   *
   * Separate from the board's pen because the two surfaces have different constraints:
   * video ink has to stay legible over arbitrary footage, so it defaults to the
   * high-contrast annotation red, while paper starts black. Sharing one pen would make
   * one surface's sensible default wrong for the other.
   */
  const [penState, setPenState] = useState<PenStyle>(DEFAULT_PEN);
  const toggleBoardMode = useBoardStore((state) => state.toggleMode);

  /*
   * The page is the **board's own**, not the playhead's.
   *
   * Pages used to be derived from the timeline's scenes, which made the deck exactly as
   * long as the project had cuts (11 pages for an 11-scene film) and made a page turn move
   * the video. Both were wrong: a sketch pad is not a second timeline, and its page count
   * must not be a function of something else.
   */
  const boardCurrent = useBoardStore((state) => state.current);
  const boardPages = useBoardStore((state) => state.pages);
  const boardStepPage = useBoardStore((state) => state.stepPage);
  const boardAddPage = useBoardStore((state) => state.addPage);

  /** Where the board is in its own deck, for the pager. */
  const boardPager = useMemo<BoardPager>(
    () => ({
      number: pageNumberOf(boardPages, boardCurrent),
      count: boardPages.length,
    }),
    [boardPages, boardCurrent],
  );

  const board = useBoard();

  /** Board undo, for the long-lived command callback. */
  const boardUndoRef = useRef<() => boolean>(() => false);

  boardUndoRef.current = board.undoPage;

  /** Board state for the long-lived shortcut callback, which cannot close over state. */
  const boardRef = useRef({ mode: boardMode });
  boardRef.current = { mode: boardMode };

  /**
   * Studio's current element selection, for the same reason.
   *
   * A ref rather than a value closed over by the command: the selection changes as the
   * user clicks around, and the shortcut handler is installed once.
   */
  const selectionRef = useRef<SelectionLike | null>(null);
  selectionRef.current = domEdit?.domEditSelection ?? null;

  // ── Key bindings: user-configurable, resolved once here ─────────────────

  /**
   * The live binding table.
   *
   * Kept in state, not read from storage on every keypress: matching happens on a
   * capture-phase listener, and a `localStorage` read per keystroke would be both slow
   * and inconsistent if it ever failed mid-session.
   */
  const [keymap, setKeymap] = useState<ResolvedKeymap>(() => loadKeymap());

  /** Apply a new keymap and persist it. Returns what was refused, if anything. */
  const applyKeymap = useCallback((next: ResolvedKeymap) => {
    setKeymap(next);
    saveKeymap(next.overrides);
  }, []);

  /**
   * Which command a key event means.
   *
   * A flat scan over the table: there are a dozen commands, and the alternative —
   * indexing by key — would have to be rebuilt whenever a binding changes, which is
   * exactly the kind of cache that goes stale.
   */
  const commandFor = useCallback(
    (event: KeyEventLike): CommandId | null => {
      for (const command of COMMANDS) {
        if (matches(keymap.bindings[command.id], event)) return command.id;
      }
      return null;
    },
    [keymap],
  );

  /**
   * Change one binding, refusing conflicts with a stated reason.
   *
   * The check happens here rather than inside the panel so that **every** path into a
   * binding goes through it — the panel is one caller today, but the storage layer and
   * any future importer are others. A conflict is not cosmetic: it makes one of the two
   * actions unreachable, and the user has no way to notice except by pressing the key
   * and watching the wrong thing happen.
   */
  const changeBinding = useCallback(
    (id: CommandId, next: Binding): string | null => {
      if (next) {
        const owner = findConflict(keymap.bindings, id, next);
        if (owner) {
          const label = COMMANDS.find((command) => command.id === owner)?.label ?? owner;
          return `${formatBinding(next)} is already used by "${label}"`;
        }
      }

      const overrides = { ...keymap.overrides, [id]: next };
      const resolved = resolveKeymap({ version: 1, overrides });
      applyKeymap(resolved);
      const refusal = resolved.rejected.find((entry) => entry.id === id);
      return refusal ? refusal.reason : null;
    },
    [applyKeymap, keymap],
  );

  /** Execute one command. Returns whether it actually did anything. */
  const runCommandNow = useCallback(
    (id: CommandId): boolean => {
      switch (id) {
        case "toggleAnnotate":
          setSurface(toggleActive);
          return true;
        case "toggleVisible":
          setSurface(toggleVisible);
          return true;
        case "toggleEditor":
          if (!shouldHandleEditorKey(fullscreenRef.current)) return false;
          setSurface(toggleEditor);
          return true;
        case "addToPrompt":
          /*
           * One call, one decision.
           *
           * This used to branch here between "the selected element" and "the newest mark", while
           * `useAnnotations` branched again — two places deciding one thing, which is how one
           * press produced two blocks (found.md F-122). The selection is handed over as **what
           * the user is pointing at**; `decideNextAction` is the only thing that decides.
           */
          annotations.addToPrompt(
            selectionRef.current ? toElementTarget(selectionRef.current) : null,
          );
          return true;
        case "undo":
          /*
           * No pre-check against a rendered `canUndo` value: that value is a snapshot
           * from the last render, and by the time a key is pressed the stack may have
           * changed. The store is asked directly and reports whether it acted, which is
           * also what decides if the key is consumed.
           */
          if (boardRef.current.mode === "board") return boardUndoRef.current();
          return annotations.undo();
        case "redo":
          // The board has no redo: a page is a scratch surface, and "redo" on a sketch
          // invites the user to believe it is a document with a history.
          if (boardRef.current.mode === "board") return false;
          return annotations.redo();
        case "toolRegion":
          annotations.setTool("region");
          return true;
        case "toolArrow":
          annotations.setTool("arrow");
          return true;
        case "toolFreehand":
          annotations.setTool("freehand");
          return true;
        case "toolEraser":
          annotations.setTool("eraser");
          return true;
        case "toolSelect":
          annotations.setTool("select");
          return true;
        case "toggleBoard":
          // The board is only meaningful while annotating; outside it there is nothing to
          // draw with, so the key falls through rather than silently doing nothing.
          if (!annotatingRef.current) return false;
          toggleBoardMode();
          return true;
      }
    },
    [annotations, toggleBoardMode],
  );

  /*
   * Forwarding layer: the listener is installed once, while the implementations behind
   * it change freely. Without this the whole policy would have to be torn down and
   * rebuilt on every state change — and any gap in that window drops keystrokes.
   */
  const commandForRef = useRef(commandFor);
  commandForRef.current = commandFor;
  const runCommandRef = useRef(runCommandNow);
  runCommandRef.current = runCommandNow;
  const annotatingRef = useRef(capturing);
  annotatingRef.current = capturing;
  const editorKeyRef = useRef<() => boolean>(() => false);
  editorKeyRef.current = () => shouldHandleEditorKey(fullscreenRef.current);

  /**
   * Install the policy on this window **and on the preview's current document**.
   *
   * Re-run whenever the preview navigates. The iframe **element** does not change on a
   * composition switch or a soft reload, but its inner window does — and a listener on the
   * old window dies with it. Studio re-attaches its own hotkeys on `load` for the same
   * reason; attaching only per element left this layer deaf inside the preview after the
   * first navigation while Studio was fully live (found.md F-089).
   */
  useEffect(() => {
    const stableHandlers: ShortcutHandlers = {
      commandFor: (event) => commandForRef.current(event),
      runCommand: (id) => runCommandRef.current(id),
      canToggleEditor: () => editorKeyRef.current(),
      /*
       * The chord goes to whoever owns the input.
       *
       * `annotatingRef` is the same flag the rest of the policy uses to decide whether a
       * command is this layer's, so zoom follows the same rule as every other key: while
       * this layer has the keyboard, it has the zoom.
       */
      onZoom: (event) => handleZoomKey(event, zoomTargetFor(annotatingRef.current)),
      isAnnotating: () => annotatingRef.current,
    };

    let uninstall: (() => void) | null = null;
    let cancelled = false;

    const install = () => {
      if (cancelled) return;
      uninstall?.();
      let frameWindow: Window | null = null;
      try {
        frameWindow = previewIframe?.contentWindow ?? null;
      } catch {
        frameWindow = null;
      }
      uninstall = installShortcutPolicyOnFrame(
        MOUSE_ONLY_POLICY,
        frameWindow,
        window,
        stableHandlers,
      );
    };

    install();
    const unsubscribe = subscribeIframeReload(previewIframe, install);

    return () => {
      cancelled = true;
      unsubscribe();
      uninstall?.();
    };
  }, [previewIframe]);

  /**
   * Top-window listener, installed **once**.
   *
   * Registration order is the whole mechanism here. A capture listener on `window` runs in
   * the order it was added, so if Studio's listener is ahead, it has already acted by the
   * time ours runs and no amount of `stopImmediatePropagation` can undo it (found.md
   * F-059). Studio's listener lives in `App`, and React runs child effects before parent
   * effects, so installing from this component *once* puts us first.
   *
   * Re-installing (the previous behaviour, keyed on `previewIframe`) moved us **behind**
   * Studio on every iframe change: the layer was active, the user pressed a bare letter,
   * and Studio's playback had already handled it (found.md F-090).
   */
  useEffect(() => {
    const stableHandlers: ShortcutHandlers = {
      commandFor: (event) => commandForRef.current(event),
      runCommand: (id) => runCommandRef.current(id),
      canToggleEditor: () => editorKeyRef.current(),
      onZoom: (event) => handleZoomKey(event, zoomTargetFor(annotatingRef.current)),
      isAnnotating: () => annotatingRef.current,
    };
    return installShortcutPolicy(MOUSE_ONLY_POLICY, window, stableHandlers);
  }, []);

  /**
   * Activation takes the keyboard away from the preview.
   *
   * Clicking the canvas puts focus **inside** the iframe, which has its own window: a key
   * pressed there never passes the top window's capture listener, so this layer cannot
   * block it and Studio's forwarded hotkeys act on it. Moving focus to the top document on
   * activation means every later keystroke starts in a window where this layer is first.
   */
  useEffect(() => {
    if (!capturing) return;
    let frameDocument: Document | null = null;
    try {
      frameDocument = previewIframe?.contentDocument ?? null;
    } catch {
      frameDocument = null;
    }
    const active = frameDocument?.activeElement ?? null;
    if (active && typeof (active as HTMLElement).blur === "function") {
      (active as HTMLElement).blur();
    }
    // The iframe element itself can hold focus; take it back explicitly.
    if (typeof document !== "undefined" && document.activeElement?.tagName === "IFRAME") {
      (document.activeElement as HTMLElement).blur();
    }
  }, [capturing, previewIframe]);

  // ── Sync the selected element into the property float ────────────────────
  const targetLabel = useMemo(() => {
    const selection = domEdit?.domEditSelection ?? null;
    if (!selection) return null;
    const label = selection.label || selection.tagName;
    const id = selection.dataAttributes?.["data-hf-id"] ?? selection.id;
    return id ? `${label} · ${id}` : label;
  }, [domEdit]);

  useEffect(() => {
    setSurface((current) => setEditorTarget(current, targetLabel));
  }, [targetLabel]);

  // ── Property float: borrow Studio's Design panel ─────────────────────────
  const floatBodyRef = useRef<HTMLDivElement | null>(null);
  /** The foreground tab of the right group before opening; handed back on close. */
  const previousPanelRef = useRef<PanelId | null>(null);
  const wantEditor = capturing && surface.editorOpen;

  useEffect(() => {
    if (!wantEditor) {
      restoreDesignPanel();
      setInspectorUnavailable(false);
      return;
    }
    const host = floatBodyRef.current;
    if (!host) return;

    /*
     * Design must be the **selected tab** before borrowing.
     *
     * dockview only renders content for the selected tab; borrowing a background
     * tab yields a zero-height shell with no children — a blank float (found.md
     * F-031). Activating only affects its own group and does not switch the user's
     * other groups.
     */
    // Remember the previous foreground tab so it can be given back on close.
    previousPanelRef.current = useDockLayoutStore.getState().activePanel;
    activatePanel("design");

    /*
     * Moving takes two beats:
     * 1. the React commit triggered by `activatePanel` mounts the Design subtree;
     * 2. dockview finishes the tab switch and size computation.
     * One 60ms timer covers it; on failure report honestly instead of showing an
     * empty float.
     */
    const timer = window.setTimeout(() => {
      setInspectorUnavailable(!borrowDesignPanel(host));
    }, 120);

    return () => {
      window.clearTimeout(timer);
      restoreDesignPanel();
      const previous = previousPanelRef.current;
      previousPanelRef.current = null;
      if (previous && previous !== "design") activatePanel(previous);
    };
  }, [wantEditor, activatePanel]);

  // Always hand the panel back when leaving activation or hiding, otherwise
  // Studio's Design tab stays permanently blank.
  useEffect(() => {
    if (capturing) return;
    restoreDesignPanel();
  }, [capturing]);

  // ── Stage rect tracking ─────────────────────────────────────────────────
  const frameRef = useRef<number | null>(null);
  /**
   * Latest stage rect, readable from long-lived listeners.
   *
   * The selection guard is installed once and asked "was the drag inside the video?"
   * on every event, so it cannot close over a state value.
   */
  const stageRectRef = useRef<PreviewStageRect | null>(null);
  stageRectRef.current = stageRect;
  useEffect(() => {
    const measure = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        const next = measureStage(previewIframe);
        // Update only when geometry actually changed: this runs every 500ms, and a
        // new object each time would re-render the whole annotation UI, which looks
        // like flickering.
        setStageRect((current) => (sameStageRect(current, next) ? current : next));
      });
    };
    measure();

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer = new ResizeObserver(measure);
    const host = previewIframe?.parentElement;
    if (host) observer.observe(host);
    if (previewIframe) observer.observe(previewIframe);

    const timer = window.setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
      window.clearInterval(timer);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [previewIframe]);

  // ── Native selection guard ───────────────────────────────────────────────
  /**
   * A drag that starts on the video must not select anything.
   *
   * Without this, pressing and dragging over empty preview space smears a selection
   * across the page and can select the `<video>` element — nothing asked for that, and
   * "I dragged where there is nothing" should be a no-op. The prompt box and other
   * editable fields stay selectable (see selectionGuard.ts).
   */
  useEffect(() => {
    return installSelectionGuard({ getStageRect: () => stageRectRef.current }, previewIframe);
  }, [previewIframe]);

  /**
   * Marks on the canvas, in painting order.
   *
   * Bound annotations come first (in binding order), unbound ones after. So the "2"
   * seen on the picture can be found as `Arrow 2` in the prompt without shifting.
   * Withdrawn marks keep their slot: the prompt still names them by that number.
   */
  /**
   * The blocks the prompt box renders, in request order.
   *
   * `order` is the request; this just narrows it to what the editor's schema can hold. The
   * numbering is the array index, so it is the same number the badges use.
   */
  const targets = useMemo(
    () =>
      annotations.order.map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        ...(entry.shape ? { shape: entry.shape } : {}),
      })),
    [annotations.order],
  );

  /**
   * Per-block visual state, for the red "withdrawn" chip.
   *
   * A map rather than a list, because the editor asks "is **this** block still on the frame"
   * once per block while painting; a list would make that a search per paint.
   */
  const blockStates = useMemo(() => {
    const map = new Map<string, { readonly withdrawn: boolean }>();
    for (const annotation of annotations.boundAnnotations) {
      map.set(`annotation:${annotation.id}`, { withdrawn: annotation.withdrawn === true });
    }
    return map;
  }, [annotations.boundAnnotations]);

  /** Format a command's live binding; the sprite and the toolbar both print these. */
  const keyOf = useCallback(
    (id: CommandId): string => formatBinding(keymap.bindings[id]),
    [keymap],
  );

  /**
   * Whether `S` would name Studio's selected element rather than the newest mark.
   *
   * Read as a value, not through the long-lived `selectionRef`: the sprite's list is a
   * render-time claim about this moment, and a ref does not tell React that it changed.
   */
  const selectionAvailable = domEdit?.domEditSelection != null;

  /**
   * Shortcuts available right now.
   *
   * The sprite lists only what can actually be pressed **at this moment**, not an
   * exhaustive catalogue. The rules live in `spriteShortcuts.ts` so they can be stated
   * and tested without mounting Studio.
   */
  const shortcuts = useMemo(
    () =>
      spriteShortcuts(
        {
          capturing,
          surfaceVisible: surface.visible,
          boardMode: boardMode === "board",
          selectionAvailable,
          boardHasInk: board.hasInk,
          canUndo: annotations.canUndo,
          canRedo: annotations.canRedo,
          hasLiveMarks: newestReferenceable(annotations.annotations) !== null,
          fullscreen: fullscreenElement !== null,
        },
        keyOf,
      ),
    [
      capturing,
      surface.visible,
      boardMode,
      selectionAvailable,
      board.hasInk,
      annotations.canUndo,
      annotations.canRedo,
      annotations.annotations,
      fullscreenElement,
      keyOf,
    ],
  );

  /**
   * The sprite lists only **top-level** panels (Preview / Timeline / Compositions /
   * Design).
   *
   * Tabs such as Assets or Code are inner tabs of the Compositions group and are
   * managed by Studio itself; listing them would suggest they can be toggled
   * independently when all it does is shuffle the group.
   */
  const panels = useMemo(
    () =>
      TOP_LEVEL_PANELS.filter((id) => panelIds.includes(id)).map((id) => ({
        id,
        title: PANEL_DEFINITIONS[id].title,
        open: openPanels.has(id),
      })),
    [panelIds, openPanels],
  );

  if (!config && !configNote) return null;

  /**
   * The stage in the **layer's** coordinates.
   *
   * `stageRect` is the video's real size on screen. The chrome lives inside a scaled
   * container, whose children lay themselves out in unscaled units — so every position
   * derived from the stage has to be divided by the scale, or at 150% the toolbar and the
   * prompt box sit a third of the way further right and down than the picture does.
   */
  const layerStage = stageRect
    ? {
        left: stageRect.left / scale,
        top: stageRect.top / scale,
        width: stageRect.width / scale,
        height: stageRect.height / scale,
      }
    : null;
  const outcomeLabel = describeOutcome(annotations.lastOutcome);
  const dockViewport = layoutViewport();
  /*
   * Both placements are in **layer** coordinates, so the viewport is passed in divided
   * by the scale as well. Reading `window.innerWidth` here told a 200%-zoomed layer it
   * had twice the room it did, and the prompt box was placed outside the window before
   * being clamped back over the picture.
   */
  const placement = promptPlacement(layerStage, dockViewport.width);
  /*
   * Default toolbar position: hug the right edge of the stage, vertically centred.
   *
   * This is only the **default** — once the user drags it, `AnnotationDock`
   * remembers their placement and stops obeying this (binding `right`/`top`
   * directly used to recompute it on every drag, so it "would not move").
   *
   * The toolbar grows **leftwards** when the board is showing (the page panel appears
   * beside the board button), so its left edge is a property of the collapsed state and
   * the expanded row never pushes it past the window edge. See `AnnotationDock`.
   */
  const dockPlacement = dockDefaultPosition(layerStage, dockViewport);

  /*
   * All overlays go into one portal whose target is decided by `overlayHost`.
   *
   * Why not just render them in the component tree: in fullscreen the browser
   * **paints only the fullscreen element's subtree**, so anything on
   * `document.body` is not painted — "in the DOM, not on screen". The input shield
   * and the canvas must move too, otherwise nothing can be drawn in fullscreen.
   */
  return createPortal(
    <>
      {/* Full-viewport shield while capturing input: swallows everything so Studio
          underneath cannot respond. Not rendered while inactive — then the window
          can only be moved and its controls take no input. */}
      {capturing ? (
        <div
          data-mystudio-overlay="shield"
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            // The shield must sit **below** the canvas (see layers.ts): it only
            // blocks Studio underneath and must not eat pointers meant for the
            // canvas. An earlier value of 55 meant clicks never reached the canvas
            // and nothing could be drawn.
            zIndex: ANNOTATION_LAYERS.shield,
            background: "transparent",
            pointerEvents: "auto",
            /*
             * Not a crosshair. This layer covers the whole window, so whatever it declares
             * is the cursor over every margin and panel gap as well; the per-tool cursor
             * belongs on the canvas, which only covers the picture.
             */
            cursor: cursorForShield(),
            // A press that lands here (empty area, or the select tool) must not start a
            // text/element selection in Studio below.
            userSelect: "none",
          }}
          onPointerDown={(event) => {
            /*
             * Clicking empty space **leaves** the layer.
             *
             * This is the mouse's way out, and it is the one the user reaches for first:
             * click the picture to draw, then click the empty margin to stop drawing. It was
             * missing, so the only exits were two chords — and once the caret was in the
             * prompt box, the layer looked "always active" with no way back (found.md F-091).
             *
             * Only a press on the **shield** does this. The shield is the area outside every
             * control (see `layers.ts`): the toolbar, the prompt box and the canvas are all
             * above it, so pressing a control never lands here.
             */
            /*
             * Empty space does **not** change activation.
             *
             * It only takes the focus back from the prompt box, which is all "I clicked
             * somewhere else" means: the caret leaves the field, the field stops being the
             * place the next keystroke goes to, and nothing about the layer's state moves.
             * Switching state is a shortcut and nothing else (found.md F-093).
             */
            if (event.button === 0) releaseFieldFocus();
            /*
             * `preventDefault` and not just `stopPropagation`.
             *
             * Stopping propagation only hides the event from other listeners; the browser
             * still moves the caret and starts a drag-selection anchored at this press.
             */
            event.preventDefault();
            event.stopPropagation();
          }}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        />
      ) : null}

      {/* Drawing canvas: takes the pointer only while active. */}
      {capturing ? (
        <AnnotationCanvas
          stageRect={stageRect}
          tool={annotations.tool}
          frameMarks={annotations.frameMarks}
          pen={boardMode === "board" ? board.pen : penState}
          board={
            boardMode === "board"
              ? { marks: board.marks, background: BOARD_PAPER }
              : null
          }
          onStroke={(shape) => {
            if (boardMode === "board") {
              board.handleStroke(shape);
              return;
            }
            void annotations.handleStroke(shape);
          }}
          onErase={(point, tolerance) => {
            /*
             * The eraser acts on whichever surface is showing, and only on it. Two stores
             * means this is a routing decision, not a filter that could be forgotten.
             */
            if (boardMode === "board") {
              board.eraseAtPoint(point, tolerance);
              return;
            }
            annotations.eraseAtPoint(point, tolerance);
          }}
        />
      ) : null}

      {/* The sprite is always resident: docked to the right edge, always explaining
          what can be done. Only meaningful with a host config, since quitting and the
          header actions all go through the bridge. */}
      {config ? (
        <ScreenSprite
          edge="right"
          shortcuts={shortcuts}
          panels={panels}
          onTogglePanel={togglePanel}
          onResetLayout={resetLayout}
          chromeVisible={chromeVisible}
          onToggleChrome={() => setChromeVisible((value) => !value)}
          project={{ name: config.projectName, dir: config.projectDir }}
          zoomTarget={zoomTargetFor(capturing)}
          onOpenProject={() => void requestOpenProject()}
          keybindings={
            <KeybindingsPanel
              commands={COMMANDS}
              bindings={keymap.bindings}
              onChange={changeBinding}
              onResetAll={() => applyKeymap(resolveKeymap(null))}
              reserved={RESERVED_KEYS}
              explainExternallyUsed={(candidate: KeyBinding) => studioConflict(candidate)}
            />
          }
          /*
           * Who receives the annotations. Read-only: a conversation subscribes from inside
           * itself, so this panel's job is to make the current audience visible — including
           * "nobody yet", which is the state where a delivery can only be queued.
           */
          conversation={
            <SubscriberPanel
              lastDelivery={
                annotations.lastOutcome?.ok ? annotations.lastOutcome.target ?? null : null
              }
            />
          }
        />
      ) : null}

      {/* The annotation window itself: rendered whenever visible, but while inactive
          it accepts no interaction at all. `pointerEvents: none` on the container
          keeps "movable only". */}
      {surface.visible ? (
        <div
          data-mystudio-overlay="surface"
          data-capturing={capturing ? "true" : "false"}
          /*
           * The chrome scales with `Ctrl` `+` / `-` / `0`.
           *
           * `transform` rather than `zoom`: the container is sized in **unscaled** units
           * (`100vw / scale`) and then scaled up, so its children keep laying themselves
           * out as if the window were that smaller size and the result fills the real
           * window exactly. `zoom` would multiply the `left`/`top` of every positioned
           * child as well, moving controls that were supposed to stay put.
           *
           * The drawing canvas is deliberately **outside** this container: annotation
           * coordinates are normalised against the video's own pixels, and scaling them
           * would move every mark already on the frame.
           */
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: `calc(100vw / ${scale})`,
            height: `calc(100vh / ${scale})`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            zIndex: ANNOTATION_LAYERS.surface,
            // The container itself must not intercept (it would cover all of
            // Studio) and does not take part in hit testing; children opt in with
            // `pointerEvents:auto`.
            pointerEvents: "none",
          }}
        >
          {/* Host unavailable: say so where the user will actually see it, not only in
              annotation mode (the window is visible but inactive from the start). */}
          {configNote ? (
            <div
              data-mystudio-overlay="config-note"
              style={{
                position: "fixed",
                right: 24,
                top: 72,
                maxWidth: 300,
                padding: 10,
                borderRadius: 8,
                background: "color-mix(in oklab, var(--color-danger, #e5484d) 14%, transparent)",
                color: "var(--color-danger-ink, #ff6b60)",
                fontSize: 12,
                lineHeight: 1.6,
                pointerEvents: "auto",
              }}
            >
              {configNote}
            </div>
          ) : null}

          {/* The toolbar belongs to the same window as the prompt panel: `H` decides
              whether both are on screen, `A` decides whether both accept input. */}
          <AnnotationDock
            tool={annotations.tool}
            onToolChange={annotations.setTool}
            onExit={() => setSurface(toggleActive)}
            onEraseHold={() => {
              /*
               * Hold-to-clear is the "everything, now" gesture, but "everything" means
               * something different per surface: every mark at every timecode on the
               * video, one page on the board. Crossing them would let a hold on the board
               * wipe annotations the user cannot see.
               */
              if (boardMode === "board") {
                board.clearPage();
                return;
              }
              annotations.clearMarks();
            }}
            /*
             * Undo/redo act on **the surface that is showing**.
             *
             * Sharing one pair means the buttons stop matching the picture: undoing on
             * the board would remove a mark from the video the user cannot see. Each
             * surface keeps its own stack, so each gets its own pair.
             */
            onUndo={boardMode === "board" ? board.undoPage : annotations.undo}
            onRedo={annotations.redo}
            canUndo={boardMode === "board" ? board.hasInk : annotations.canUndo}
            // The board has no redo: a page is a scratch surface, not a document.
            canRedo={boardMode === "board" ? false : annotations.canRedo}
            boardMode={boardMode === "board"}
            onToggleBoard={() => toggleBoardMode()}
            /*
             * The pen is present in **both** modes. Thickness matters on footage as much
             * as on paper, and hiding the control on the video made it board-only for no
             * reason. Each surface keeps its own pen, so the value shown is the one in use.
             */
            pen={boardMode === "board" ? board.pen : penState}
            onPenChange={boardMode === "board" ? board.setPen : setPenState}
            lightSurface={boardMode === "board"}
            /*
             * Only on the board. Passing it unconditionally put a "clear this page"
             * button in the video toolbar, where pressing it would clear a page the user
             * cannot see — so the prop's presence *is* the visibility rule.
             */
            boardPager={boardMode === "board" ? boardPager : undefined}
            onStepBoardPage={boardStepPage}
            onAddBoardPage={boardAddPage}
            onClearBoardPage={boardMode === "board" ? () => board.clearPage() : undefined}
            boardHasInk={board.hasInk}
            defaultPosition={dockPlacement}
            keyHint={keyOf}
            interactive={capturing}
          />

          <FloatingPanel
            id="prompt"
            defaultPosition={placement.position}
            defaultWidth={placement.width}
            defaultHeight={240}
            interactive={capturing}
            placementReady={stageRect !== null}
            title={
              <span
                data-mystudio-overlay="prompt-dialog"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                Prompt
                {outcomeLabel ? (
                  /*
                   * The label names the session the prompt actually landed in, with the
                   * reason in the tooltip. "Sent" alone could not be checked: the plugin
                   * chooses the session, and a wrong guess is invisible otherwise.
                   */
                  <span
                    role="status"
                    data-mystudio-overlay="delivery-outcome"
                    title={outcomeLabel.title}
                    style={{
                      maxWidth: 210,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: annotations.lastOutcome?.ok
                        ? "var(--color-accent-ink)"
                        : "var(--color-danger-ink)",
                    }}
                  >
                    {outcomeLabel.text}
                  </span>
                ) : null}
                {!capturing ? <span style={{ opacity: 0.55 }}>Inactive · press A</span> : null}
              </span>
            }
          >
            <PromptComposer
              targets={targets}
              states={blockStates}
              onTextChange={annotations.setPromptText}
              onRemoveBlock={annotations.removeBlock}
              onSend={() => void annotations.deliver()}
              delivering={annotations.delivering}
              canSend={capturing && annotations.hasDeliverable}
            />

            {annotations.frameWarning ? (
              <div
                style={{
                  marginTop: 6,
                  padding: "4px 6px",
                  borderRadius: 4,
                  background: "color-mix(in oklab, var(--color-warning-ink) 16%, transparent)",
                  color: "var(--color-warning-ink)",
                  fontSize: 10,
                  lineHeight: 1.5,
                }}
              >
                {annotations.frameWarning}
              </div>
            ) : null}
          </FloatingPanel>

          {capturing && surface.editorOpen ? (
            <FloatingPanel
              id="inspector"
              defaultPosition={{ x: 24, y: 96 }}
              defaultWidth={300}
              defaultHeight={420}
              interactive
              placementReady
              title={
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {surface.editorTarget ?? "Select an element"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSurface(toggleEditor)}
                    title={`Close (${keyOf("toggleEditor")})`}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      opacity: 0.5,
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </span>
              }
            >
              {inspectorUnavailable ? (
                <div style={{ padding: "10px 4px", lineHeight: 1.6, opacity: 0.6 }}>
                  Design panel not found. Open the Design tab in Studio first, then press E.
                </div>
              ) : (
                <div
                  ref={floatBodyRef}
                  data-mystudio-overlay="inspector-host"
                  style={{ minHeight: 120 }}
                />
              )}
            </FloatingPanel>
          ) : null}
        </div>
      ) : null}
    </>,
    overlayHost,
  );
}
