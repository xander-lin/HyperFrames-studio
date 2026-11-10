/**
 * Making Studio genuinely unreachable while this layer is active.
 *
 * ## The requirement
 *
 * The two states must be **two applications that cannot affect each other** — not "the key
 * happens to do nothing over there":
 *
 * > "激活模式下所有键都是自己的，不管是自己注册了还是没注册… 得把它吃掉啊，不应该让它再传到下一层。
 * > …不是说看起来没影响，它就没影响。是设计上必须把它设计成完全不可能互相影响。"
 *
 * ## Why the event chain cannot deliver this
 *
 * Both this layer and Studio listen on the same `window`, and the propagation chain is
 *
 * ```
 * window (capture)  →  …  →  the editor (target)  →  …  →  window (bubble)
 * ```
 *
 * Our listener sits at the outermost point. Stopping the event there means the editor — the
 * **target** — never receives it, so the character is never typed. Not stopping it means
 * Studio's own handlers all run, and 16 of the 38 keydown listeners in Studio have no
 * "is this a text field" guard at all. Choosing between those two is not a design; it is a
 * coin flip that depends on which listener happens to have a guard.
 *
 * ## What does deliver it
 *
 * `inert` on Studio's root element. It is a browser-level statement — "nothing inside this
 * subtree is interactive" — so it does not have to beat anyone in a race, and it does not
 * depend on Studio's code being careful:
 *
 * - focus cannot enter it,
 * - pointer events are not delivered to it,
 * - it is removed from the accessibility tree,
 * - and key events never reach its handlers, because nothing inside can be the target.
 *
 * The prompt box is not inside that subtree: the annotation surface is a sibling of Studio's
 * `#root` under `<body>`, which is what makes this possible at all.
 *
 * ## What is deliberately *not* affected
 *
 * `inert` suspends **interaction**, not rendering: the composition preview keeps playing, the
 * canvas keeps drawing, and nothing is unmounted. That matters because the picture the user
 * captures is of the very surface this must not disturb.
 */

/** The element Studio renders into. Everything of Studio lives inside it. */
const STUDIO_ROOT_SELECTOR = "#root";

/** Marks the state so it can be asserted and debugged from the outside. */
const ACTIVE_ATTRIBUTE = "data-studio-inert";

/**
 * Make Studio non-interactive, returning a function that restores it.
 *
 * Idempotent: calling it twice is harmless, and the returned undo restores the **previous**
 * value rather than assuming it was `false` — a caller that nests these must not re-enable
 * Studio underneath an outer activation.
 */
export function suspendStudio(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const root = document.querySelector<HTMLElement>(STUDIO_ROOT_SELECTOR);
  if (!root) return () => undefined;

  const previous = root.inert;
  root.inert = true;
  root.setAttribute(ACTIVE_ATTRIBUTE, "true");

  return () => {
    root.inert = previous;
    if (!previous) root.removeAttribute(ACTIVE_ATTRIBUTE);
  };
}

/**
 * Whether Studio is currently suspended.
 *
 * Read by the runtime check, so the isolation is an observable fact rather than an implicit
 * one — "it seems not to react" is exactly the kind of conclusion that has been wrong before.
 */
export function studioIsSuspended(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.querySelector<HTMLElement>(STUDIO_ROOT_SELECTOR);
  return root?.inert === true;
}
