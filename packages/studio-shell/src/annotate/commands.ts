/**
 * The command registry: what exists, what can be rebound, and at what it defaults.
 *
 * ## Why the tool keys are `Ctrl+Shift+1..5`, not `Ctrl+1..5`
 *
 * `Ctrl+1` and `Ctrl+2` are Studio's own tab shortcuts. Binding tools to the same chords
 * meant **one press did two things** — the tool changed *and* a panel activated — because
 * `stopImmediatePropagation` cannot stop a listener that has already run, and Studio's
 * listener is registered before ours.
 *
 * Two changes came out of that, and both are now rules (see `studioConflict.ts`):
 *
 * 1. **Never sit on a chord another part of the app owns.** Either the other owner is
 *    moved, or the key is not used.
 * 2. **Prefer a chord the other side cannot even express.** Studio's shortcut grammar
 *    refuses `shift` together with a digit, so `Ctrl+Shift+1` is structurally
 *    unoccupiable by it — a stronger guarantee than checking a table that may grow.
 *
 * ## Which shortcuts are configurable, and why the others are not
 *
 * The rule is not "some are configurable because we felt like it". It follows from one
 * question: **does the user own this key, or does the platform?** Three answers, three
 * tiers.
 *
 * 1. **Configurable commands** — the annotation layer's own actions. The user pressed
 *    nothing before this layer existed, so there is no habit to break and no other
 *    owner to collide with. Toggle, tools, prompt insertion: all of these.
 *
 * 2. **Fixed safety valves** — `Escape`. It has no mouse equivalent and must always
 *    cancel the current operation. If a user could rebind or unbind it, they could
 *    configure themselves into a state with no way out. A safety valve that needs a
 *    chord, or that can be unbound, is not a safety valve.
 *
 * 3. **Not ours at all** — the browser's clipboard and the operating system's zoom and
 *    window switching. `Ctrl+C`, `Ctrl+V`, `Ctrl+Q` belong to someone else; offering to
 *    rebind them would be offering to break something we do not control.
 *
 * So the sprite lists exactly the commands in tier 1, and the UI says plainly why the
 * other keys are absent rather than silently omitting them.
 */

import type { AnnotationTool } from "./editorState.js";
import { binding, type Binding, type KeyBinding } from "./keybinding.js";

/** Every action the annotation layer performs from the keyboard. */
export type CommandId =
  | "toggleAnnotate"
  | "toggleVisible"
  | "toggleEditor"
  | "addToPrompt"
  | "undo"
  | "redo"
  | "toolRegion"
  | "toolArrow"
  | "toolFreehand"
  | "toolEraser"
  | "toolSelect"
  | "toggleBoard";

export interface CommandDefinition {
  readonly id: CommandId;
  /** Shown in the sprite; short. */
  readonly label: string;
  /** One line explaining what it does right now. Used as the hover text. */
  readonly detail: string;
  /** Whether the user may change it. See the module comment for the tier rules. */
  readonly configurable: boolean;
  /** Default binding; `null` means the command starts unbound. */
  readonly defaultBinding: Binding;
  /** Only meaningful while annotating; the UI groups these separately. */
  readonly annotationOnly: boolean;
}

/**
 * The table.
 *
 * Defaults all carry `Ctrl`. A bare letter is a typing key — `s` must produce `s` in
 * any text field — so binding one to an action is a permanent conflict waiting to fire.
 */
export const COMMANDS: readonly CommandDefinition[] = [
  {
    id: "toggleAnnotate",
    label: "Start / stop annotating",
    detail: "Activates the annotation window and takes over input; press again to hand control back",
    configurable: true,
    defaultBinding: binding("KeyA", { ctrl: true }),
    annotationOnly: false,
  },
  {
    id: "toggleVisible",
    label: "Show / hide window",
    detail: "Toggles visibility only — it does not change whether the window is active",
    configurable: true,
    defaultBinding: binding("KeyH", { ctrl: true }),
    annotationOnly: false,
  },
  {
    id: "toggleEditor",
    label: "Properties panel",
    detail: "Summons the Design panel over the video; only works while the video is fullscreen",
    configurable: true,
    defaultBinding: binding("KeyE", { ctrl: true }),
    annotationOnly: true,
  },
  {
    id: "addToPrompt",
    label: "Add the newest mark to the prompt",
    detail: "Appends its block reference on a new line at the end of the prompt",
    configurable: true,
    defaultBinding: binding("KeyS", { ctrl: true }),
    annotationOnly: true,
  },
  {
    id: "undo",
    label: "Undo drawing",
    detail: "Removes the newest mark; if it is already in the prompt its block turns red instead",
    configurable: true,
    defaultBinding: binding("KeyZ", { ctrl: true }),
    annotationOnly: true,
  },
  {
    id: "redo",
    label: "Redo drawing",
    detail: "Re-applies the last undone drawing action",
    configurable: true,
    defaultBinding: binding("KeyZ", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toolRegion",
    label: "Region tool",
    detail: "Drag out a rectangular area on the canvas",
    configurable: true,
    defaultBinding: binding("Digit1", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toolArrow",
    label: "Arrow tool",
    detail: "Drag from an element to a target; the element is recorded",
    configurable: true,
    defaultBinding: binding("Digit2", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toolFreehand",
    label: "Freehand tool",
    detail: "Draw freely",
    configurable: true,
    defaultBinding: binding("Digit3", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toolEraser",
    label: "Eraser",
    detail: "Click to erase one mark · hold the eraser button to clear every mark at every timecode",
    configurable: true,
    defaultBinding: binding("Digit5", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toolSelect",
    label: "Select tool",
    detail: "Stop drawing; the canvas ignores the pointer",
    configurable: true,
    defaultBinding: binding("Digit4", { ctrl: true, shift: true }),
    annotationOnly: true,
  },
  {
    id: "toggleBoard",
    label: "Video / whiteboard",
    detail: "Swaps the picture for a blank page of the same size; each side keeps its own ink",
    configurable: true,
    defaultBinding: binding("KeyB", { ctrl: true }),
    annotationOnly: true,
  },
  /*
   * Note what is **not** here: `Ctrl+A`.
   *
   * This layer's activation toggle sits on it, and a text field means "select all" by the
   * same chord. Rather than adding a second command to represent the text-field meaning —
   * which would give one chord two declared owners, the exact defect this table exists to
   * prevent — `toggleAnnotate` yields when the caret is in a field (see
   * `yieldsToTextEditing`). One key, one owner; the owner simply knows when to stand
   * aside.
   */
];

/**
 * Whether this command only exists while the layer is active.
 *
 * Note what is **not** here: `toggleAnnotate` and `toggleVisible` work from either state —
 * they are how the layer is reached and hidden. Everything else is a drawing action, and a
 * drawing action must not claim its chord while there is nothing to draw on.
 *
 * Derived from the table's own `annotationOnly` flag rather than from a second list: a
 * hand-maintained copy of "which commands are active-only" would drift from the table the
 * moment a command is added with the wrong flag.
 */
export function isActiveOnlyCommand(id: CommandId): boolean {
  return COMMANDS.find((command) => command.id === id)?.annotationOnly === true;
}

/** Which command selects each tool, for the tool-state mirror. */
export const TOOL_COMMANDS: Readonly<Record<AnnotationTool, CommandId>> = {
  region: "toolRegion",
  arrow: "toolArrow",
  freehand: "toolFreehand",
  eraser: "toolEraser",
  select: "toolSelect",
};

/** Every binding, resolved. A lookup table, so matching is one pass. */
export type Bindings = Readonly<Record<CommandId, Binding>>;

/** The bindings a fresh install starts with. */
export function defaultBindings(): Bindings {
  const result = {} as Record<CommandId, Binding>;
  for (const command of COMMANDS) result[command.id] = command.defaultBinding;
  return result;
}

/**
 * The keys this layer does **not** own, stated so the UI can say why they are absent.
 *
 * Listing them is not decoration: "why is my shortcut not in the list" is the first
 * question a configurable system raises, and answering it in the interface is cheaper
 * than answering it per user.
 */
export const RESERVED_KEYS: readonly { readonly keys: string; readonly owner: string }[] = [
  { keys: "Escape", owner: "Cancels the current operation — a safety valve, never rebindable" },
  { keys: "Ctrl + C / V / X", owner: "The clipboard, handled by the browser and the text field" },
  {
    keys: "Ctrl + + / - / 0",
    owner:
      "Interface zoom. It is not rebindable because it is not one command: while annotating it resizes this layer, otherwise it resizes Studio. Listing it here says where it lives rather than offering to move it",
  },
  { keys: "Ctrl + W / Q", owner: "Window and application management, owned by the desktop" },
  { keys: "Ctrl + Z inside the prompt box", owner: "Text editing undo, owned by the prompt box itself" },
  {
    keys: "Studio's own keys",
    owner:
      "Tabs, playback and timeline shortcuts belong to Studio. A key it already uses cannot also be ours: one press would do both — so those keys are refused, not shared",
  },
];
