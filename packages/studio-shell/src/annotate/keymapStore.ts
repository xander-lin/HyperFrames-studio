/**
 * User key bindings: storage, validation and conflict resolution.
 *
 * ## What is stored
 *
 * Only the **overrides**, not the whole table. A stored file therefore keeps working
 * when a future version adds a command or changes a default: everything the user never
 * touched keeps following the defaults. Storing the whole table would pin old defaults
 * forever, and a bad file could silently drop a command to "unbound".
 *
 * ## What is refused
 *
 * Two rules, and both are about trust in the configuration:
 *
 * 1. A binding that would steal a typing key (see `keybinding.isAllowedBinding`) is
 *    dropped on load, not merely refused in the UI. A hand-edited file must not be able
 *    to create a state the interface would never allow.
 * 2. Two commands on the same key is dropped **on read**, keeping the first. A conflict
 *    is not a UI annoyance — it means one of the two actions is unreachable, and the
 *    user has no way to discover that except by pressing the key and watching what
 *    happens.
 */

import { COMMANDS, defaultBindings, type Bindings, type CommandId } from "./commands.js";
import {
  explainRejection,
  formatBinding,
  isAllowedBinding,
  sameBinding,
  type Binding,
} from "./keybinding.js";

export interface KeymapFile {
  /** Bump when the storage shape changes; unknown versions are ignored, not crashed on. */
  readonly version: 1;
  /** Only the commands the user changed. */
  readonly overrides: Partial<Record<CommandId, Binding>>;
}

/** A command two others collide with. */
export interface Conflict {
  readonly id: CommandId;
  readonly withId: string;
  readonly binding: string;
}

export interface ResolvedKeymap {
  readonly bindings: Bindings;
  /** Overrides that were accepted. */
  readonly overrides: Partial<Record<CommandId, Binding>>;
  /** Overrides that were thrown away, with the reason, for a one-time notice. */
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}

const STORAGE_KEY = "mystudio:keymap";

/** Whether an id names a command that exists in this version. */
function isCommandId(value: string): value is CommandId {
  return COMMANDS.some((command) => command.id === value);
}

/** Whether an id may be rebound at all. */
function isConfigurable(id: CommandId): boolean {
  const command = COMMANDS.find((candidate) => candidate.id === id);
  return command?.configurable === true;
}

/**
 * Merge stored overrides over the defaults.
 *
 * `raw` is untrusted: it comes from `localStorage` or a hand-edited file. Everything is
 * re-validated here rather than trusting the writer, because the writer may be an older
 * version of this program or a text editor.
 */
export function resolveKeymap(raw: unknown): ResolvedKeymap {
  const defaults = defaultBindings();
  const overrides: Partial<Record<CommandId, Binding>> = {};
  const rejected: Array<{ id: string; reason: string }> = [];

  const candidate = isKeymapFile(raw) ? raw.overrides : {};

  for (const [id, value] of Object.entries(candidate)) {
    if (!isCommandId(id)) {
      rejected.push({ id, reason: "Unknown command in the stored key bindings" });
      continue;
    }
    if (!isConfigurable(id)) {
      rejected.push({ id, reason: "This command is not configurable" });
      continue;
    }
    // `null` is a legitimate override: "I do not want a shortcut for this".
    if (value !== null && !isAllowedBinding(value)) {
      rejected.push({ id, reason: explainRejection(value as never) ?? "That key is not allowed" });
      continue;
    }
    overrides[id] = value;
  }

  const bindings: Record<CommandId, Binding> = { ...defaults };
  for (const [id, value] of Object.entries(overrides) as Array<[CommandId, Binding]>) {
    bindings[id] = value;
  }

  // Conflicts: keep the first command in table order, drop the later one.
  const committed = new Map<string, CommandId>();
  for (const command of COMMANDS) {
    const value = bindings[command.id];
    if (!value) continue;
    const key = bindingText(value);
    const owner = committed.get(key);
    if (owner) {
      rejected.push({
        id: command.id,
        reason: `${formatBinding(value)} is already used by "${labelOf(owner)}"`,
      });
      // Fall back to the default for the loser, then to unbound if that also collides.
      const fallback = command.defaultBinding;
      const fallbackKey = fallback ? bindingText(fallback) : null;
      bindings[command.id] =
        fallback && fallbackKey && !committed.has(fallbackKey) ? fallback : null;
      if (bindings[command.id]) committed.set(bindingText(bindings[command.id] as Binding), command.id);
      continue;
    }
    committed.set(key, command.id);
  }

  // A rejected override must not linger in what we report as "the user's settings".
  for (const entry of rejected) {
    if (isCommandId(entry.id)) delete overrides[entry.id];
  }

  return { bindings, overrides, rejected };
}

function isKeymapFile(value: unknown): value is KeymapFile {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { overrides?: unknown }).overrides === "object" &&
    (value as { overrides?: unknown }).overrides !== null
  );
}

function labelOf(id: CommandId): string {
  return COMMANDS.find((command) => command.id === id)?.label ?? id;
}

/** Comparison key for "same physical combination"; `formatBinding` is for display. */
function bindingText(value: Binding): string {
  if (!value) return "";
  return [
    value.ctrl ? "Ctrl" : "",
    value.meta ? "Meta" : "",
    value.alt ? "Alt" : "",
    value.shift ? "Shift" : "",
    value.code,
  ]
    .filter(Boolean)
    .join("+");
}

/**
 * Check a proposed binding against everything else.
 *
 * Returns the command already using it, or null. Used by the settings UI so a conflict
 * is refused **before** it is saved, instead of being silently resolved later.
 */
export function findConflict(
  bindings: Bindings,
  id: CommandId,
  candidate: Binding,
  idForBinding: (value: Binding) => CommandId | null = (value) => {
    for (const command of COMMANDS) {
      if (sameBinding(bindings[command.id], value)) return command.id;
    }
    return null;
  },
): CommandId | null {
  if (!candidate) return null;
  const owner = idForBinding(candidate);
  return owner && owner !== id ? owner : null;
}

/** Load overrides from storage. Never throws: a broken file means "use defaults". */
export function loadKeymap(): ResolvedKeymap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return resolveKeymap(null);
    return resolveKeymap(JSON.parse(raw));
  } catch {
    return resolveKeymap(null);
  }
}

/** Persist overrides. Storage failures are reported, not swallowed silently. */
export function saveKeymap(overrides: Partial<Record<CommandId, Binding>>): boolean {
  try {
    const file: KeymapFile = { version: 1, overrides };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}
