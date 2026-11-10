/**
 * Taking the caret out of a text field, for a **pointer** action.
 *
 * ## Why this is needed at all
 *
 * The prompt box is a contenteditable. Once the user clicks into it, the caret stays there
 * until something else takes focus — and the annotation layer deliberately calls
 * `preventDefault` on pointer events over the picture, which **also** suppresses the
 * browser's normal focus change. So drawing on the canvas left the caret in the text box:
 * `Ctrl+Z` still addressed the text, and the box kept looking active while the pointer was
 * somewhere else entirely (found.md F-102).
 *
 * ## Why blur rather than moving focus
 *
 * A pointer action on the picture should not give any element a focus ring, and the canvas
 * is deliberately not focusable (a pointer-driven layer needs no keyboard focus). Blur is
 * the exact "stop typing here" and nothing more.
 */

/** Elements whose caret this layer may take away. */
function isTextField(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/**
 * Blur the focused text field, if there is one.
 *
 * Safe to call from any pointer handler: it does nothing when no field has focus, and it
 * never throws for a detached node.
 */
export function releaseFieldFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !isTextField(active)) return;
  try {
    active.blur();
  } catch {
    // A node mid-teardown cannot be blurred; there is nothing to keep focused either way.
  }
}
