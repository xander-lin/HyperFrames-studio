/**
 * Block the browser's native selection gesture over the video canvas.
 *
 * ## The problem
 *
 * Press-and-drag is the primary gesture here. If the drag starts on the preview
 * background — where there is no element to annotate — the browser treats it as a
 * **selection gesture**: it smears a highlight across the page and can even select the
 * `<video>` element itself. Nothing asked for that. The user dragged on empty space,
 * so nothing should happen.
 *
 * ## Why not `user-select: none` globally
 *
 * That would also break every place where selecting text *is* the point: the prompt
 * box, the code editor, the composition's own text being edited. The rule we actually
 * want is "a drag that **starts on the video stage** must not select", not "selection
 * is off".
 *
 * ## How it works
 *
 * The guard remembers where the pointer went down. A `selectstart` / `dragstart` is
 * suppressed only when that starting point was inside the video stage and the target is
 * not an editable control. So:
 * - drag across the canvas → nothing selected;
 * - drag across the prompt box → text selected normally;
 * - drag in the code editor → normal.
 *
 * ## The iframe
 *
 * The composition renders in the preview iframe, which has its **own** document, so
 * `selectstart` fires there. From the same origin both documents can be guarded. The
 * whole iframe *is* the stage, so inside it every drag qualifies.
 */

/** A viewport rectangle, in the top window's coordinate space. */
export interface StageRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Minimal node shape for the checks below; structural so it survives across realms. */
interface NodeLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/**
 * Whether the target is a control that must keep native selection behaviour.
 *
 * Editable fields and explicit `data-mystudio-selectable` markers are exempt.
 */
export function isSelectableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const node = target as NodeLike;

  const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (node.isContentEditable === true) return true;

  if (typeof node.getAttribute === "function") {
    try {
      if (node.getAttribute("contenteditable") === "true") return true;
      if (node.getAttribute("data-mystudio-selectable") !== null) return true;
    } catch {
      // Synthetic nodes may throw; treating them as plain nodes is fine.
    }
  }

  // A drag beginning inside the prompt box must still select text there.
  if (typeof node.closest === "function") {
    try {
      if (node.closest("[data-mystudio-selectable]") !== null) return true;
    } catch {
      // Ignore selector errors.
    }
  }

  return false;
}

/** Whether a viewport point falls inside the stage. */
export function pointInStage(
  point: { readonly x: number; readonly y: number },
  stage: StageRectLike | null,
): boolean {
  if (!stage) return false;
  return (
    point.x >= stage.left &&
    point.x <= stage.left + stage.width &&
    point.y >= stage.top &&
    point.y <= stage.top + stage.height
  );
}

/** Events that would turn a drag into a selection. */
const GUARDED_EVENTS = ["selectstart", "dragstart"] as const;

export interface SelectionGuardOptions {
  /** Current video stage rect in the top window's coordinates; null while unknown. */
  readonly getStageRect: () => StageRectLike | null;
}

/**
 * Install the guard on the app document.
 *
 * @param options supplies the current stage rect
 * @returns uninstall function
 */
export function installSelectionGuardOnTop(options: SelectionGuardOptions): () => void {
  let startedOnStage = false;

  const onPointerDown = (event: Event) => {
    const point = event as PointerEvent;
    startedOnStage = pointInStage(
      { x: point.clientX ?? 0, y: point.clientY ?? 0 },
      options.getStageRect(),
    );
  };

  const onPointerUp = () => {
    startedOnStage = false;
  };

  const onGuardedEvent = (event: Event) => {
    if (!startedOnStage) return;
    if (isSelectableTarget(event.target)) return;
    // `preventDefault` is what actually cancels the selection; stopping propagation
    // only hides the event from other listeners.
    event.preventDefault();
  };

  // Capture phase: run before the page's own handlers can begin a selection.
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("pointerup", onPointerUp, { capture: true });
  document.addEventListener("pointercancel", onPointerUp, { capture: true });
  for (const type of GUARDED_EVENTS) {
    document.addEventListener(type, onGuardedEvent, { capture: true });
  }

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    document.removeEventListener("pointerup", onPointerUp, { capture: true });
    document.removeEventListener("pointercancel", onPointerUp, { capture: true });
    for (const type of GUARDED_EVENTS) {
      document.removeEventListener(type, onGuardedEvent, { capture: true });
    }
  };
}

/**
 * Install the guard inside the preview iframe.
 *
 * The whole iframe is the stage, so any drag there qualifies. Editable text inside the
 * composition is still exempt — editing it is a Studio feature, not an accident.
 *
 * @param doc the iframe's document
 * @returns uninstall function
 */
export function installSelectionGuardInFrame(doc: Document): () => void {
  let dragging = false;

  const onPointerDown = () => {
    dragging = true;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onGuardedEvent = (event: Event) => {
    if (!dragging) return;
    if (isSelectableTarget(event.target)) return;
    event.preventDefault();
  };

  doc.addEventListener("pointerdown", onPointerDown, { capture: true });
  doc.addEventListener("pointerup", onPointerUp, { capture: true });
  doc.addEventListener("pointercancel", onPointerUp, { capture: true });
  for (const type of GUARDED_EVENTS) {
    doc.addEventListener(type, onGuardedEvent, { capture: true });
  }

  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, { capture: true });
    doc.removeEventListener("pointerup", onPointerUp, { capture: true });
    doc.removeEventListener("pointercancel", onPointerUp, { capture: true });
    for (const type of GUARDED_EVENTS) {
      doc.removeEventListener(type, onGuardedEvent, { capture: true });
    }
  };
}

/**
 * Install on both documents: the app's and the preview iframe's.
 *
 * A cross-origin iframe cannot be reached; that is not a failure, because in that case
 * the composition could not be annotated either.
 *
 * @param options supplies the current stage rect
 * @param iframe the preview iframe, or null while it is still loading
 * @returns uninstall function
 */
export function installSelectionGuard(
  options: SelectionGuardOptions,
  iframe: HTMLIFrameElement | null,
): () => void {
  const cleanups: Array<() => void> = [];

  if (typeof document !== "undefined") {
    cleanups.push(installSelectionGuardOnTop(options));
  }

  let frameDoc: Document | null = null;
  try {
    frameDoc = iframe?.contentDocument ?? null;
  } catch {
    frameDoc = null;
  }
  if (frameDoc && frameDoc !== document) {
    cleanups.push(installSelectionGuardInFrame(frameDoc));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
