/**
 * Header action registry.
 *
 * Why it exists: the header must be hideable as a whole, giving the space back to
 * the canvas. But its functions (Capture / Inspector / Export / theme) must not
 * disappear with it — they move into the screen sprite and stay usable.
 *
 * So the header registers its actions on mount and the sprite reads the same table
 * to trigger them. The header is only hidden with CSS (`display:none`), **never
 * unmounted**, which means:
 * - upstream button logic, disabled states and aria are preserved; there is no
 *   second implementation;
 * - the actions still fire while hidden, so nothing becomes "hidden means dead".
 *
 * `useSyncExternalStore` lets React observe registry changes.
 */

export interface HeaderActions {
  /** Capture: the current frame as a data URL / download link. */
  readonly capture: {
    readonly href: string;
    readonly filename: string;
    readonly onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    readonly refreshTime: () => void;
    readonly capturing: boolean;
  };
  /** Whether the inspector is open (for the check mark). */
  readonly inspectorActive: boolean;
  readonly toggleInspector: () => void;
  readonly exportDisabled: boolean;
  readonly exporting: boolean;
  readonly ffmpegMissing: boolean;
  readonly onExport: () => void;
  /** Switch between light and dark theme. */
  readonly toggleTheme: () => void;
  /** Whether the theme is currently dark (for the label). */
  readonly isDark: boolean;
}

let current: HeaderActions | null = null;
const listeners = new Set<() => void>();

export function registerHeaderActions(actions: HeaderActions): () => void {
  current = actions;
  for (const listener of listeners) listener();
  return () => {
    if (current === actions) current = null;
    for (const listener of listeners) listener();
  };
}

export function getHeaderActions(): HeaderActions | null {
  return current;
}

export function subscribeHeaderActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
