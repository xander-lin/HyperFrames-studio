/**
 * The key-binding editor, shown inside the screen sprite.
 *
 * ## Why it lives there
 *
 * The sprite is already "the place you go to change how this app behaves": panels,
 * theme, zoom, quit. Shortcuts belong with them — one surface for settings, never a
 * second dialog that floats somewhere else and can be lost behind the window.
 *
 * ## How it decides what is configurable
 *
 * It does not. `commands.ts` owns that decision, and this component only renders what
 * the registry says. That is deliberate: a settings screen that keeps its own idea of
 * which commands exist will eventually offer a row for a command that was removed, or
 * hide one that was added. There is one list, and both the dispatcher and this table
 * read it.
 *
 * ## Recording a binding
 *
 * Click the row, press the combination, done. Recording is a real key capture: while
 * armed, the editor listens on the window in the capture phase and swallows everything,
 * so pressing `Ctrl+A` here changes the binding instead of activating the annotation
 * window. That is the only way the screen can accept the keys it is editing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandId, CommandDefinition } from "./commands.js";
import {
  bindingFromEvent,
  explainRejection,
  formatBinding,
  isAllowedBinding,
  sameBinding,
  type Binding,
  type KeyBinding,
} from "./keybinding.js";

export interface KeybindingsPanelProps {
  readonly commands: readonly CommandDefinition[];
  /** Current resolved binding for each command. */
  readonly bindings: Readonly<Record<CommandId, Binding>>;
  /** Set one binding. Returns the human-readable reason when refused. */
  readonly onChange: (id: CommandId, next: Binding) => string | null;
  /** Put every command back to its default. */
  readonly onResetAll: () => void;
  /** Keys this layer does not own, so the panel can say why they are missing. */
  readonly reserved: readonly { readonly keys: string; readonly owner: string }[];
  /**
   * Why a key cannot be used because **another part of the application** owns it.
   *
   * Separate from a clash inside this layer, and it needs to exist because the two fail
   * differently: an internal clash means one of our actions is unreachable, while an
   * external one means a single press performs two different things at once — and the
   * other thing is outside our control, so refusing the binding is the only fix.
   */
  readonly explainExternallyUsed?: (candidate: KeyBinding) => string | null;
}

const ACCENT = "var(--color-accent, #37b878)";

export function KeybindingsPanel(props: KeybindingsPanelProps) {
  /** The command currently capturing a keypress. */
  const [recording, setRecording] = useState<CommandId | null>(null);
  /** The problem with the last attempt, shown next to the row. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Capture the next combination.
   *
   * Capture phase and `preventDefault`: while this is armed, the keystroke must not
   * also reach the annotation layer, or clicking a row would trigger the command it is
   * trying to edit. Escape cancels — the one key that always means "stop".
   */
  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.code === "Escape") {
        setRecording(null);
        setNotice(null);
        return;
      }

      const candidate = bindingFromEvent(event);

      // Backspace with no modifier clears the binding: "I do not want a shortcut".
      if (candidate.code === "Backspace" && !candidate.ctrl && !candidate.alt && !candidate.meta) {
        const reason = props.onChange(recording, null);
        setNotice(reason);
        if (!reason) setRecording(null);
        return;
      }

      // A modifier held on its own is not a shortcut yet; wait for the real key.
      if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.test(candidate.code)) return;

      if (!isAllowedBinding(candidate)) {
        setNotice(explainRejection(candidate) ?? "That key is not allowed");
        return;
      }

      /*
       * Check the rest of the app before saving.
       *
       * This has to happen here rather than only in the layer's own conflict check: the
       * collision is with a key this layer does not manage, so refusing it early is the
       * only way to keep one press to one action.
       */
      const external = props.explainExternallyUsed?.(candidate);
      if (external) {
        setNotice(`${formatBinding(candidate)} is already used by ${external}`);
        return;
      }

      const reason = props.onChange(recording, candidate);
      setNotice(reason);
      if (!reason) setRecording(null);
    };

    // Capture on the window so nothing below can act on the key first.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, props]);

  const resetOne = useCallback(
    (id: CommandId) => {
      const command = props.commands.find((candidate) => candidate.id === id);
      if (!command) return;
      const reason = props.onChange(id, command.defaultBinding);
      setNotice(reason);
    },
    [props],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {props.commands.map((command) => {
        const current = props.bindings[command.id];
        const isDefault = sameBinding(current, command.defaultBinding);
        const isRecording = recording === command.id;

        return (
          <div
            key={command.id}
            title={command.detail}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 2px",
              borderRadius: 6,
              background: isRecording
                ? "color-mix(in oklab, " + ACCENT + " 14%, transparent)"
                : "transparent",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{command.label}</span>

            {!isDefault ? (
              <button
                type="button"
                onClick={() => resetOne(command.id)}
                title={`Reset to ${formatBinding(command.defaultBinding)}`}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  opacity: 0.4,
                  cursor: "pointer",
                  fontSize: 10,
                  lineHeight: 1,
                  padding: "0 1px",
                }}
              >
                ↺
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setRecording(isRecording ? null : command.id);
              }}
              aria-label={`Change the shortcut for ${command.label}`}
              style={{
                minWidth: 74,
                padding: "1px 6px",
                borderRadius: 4,
                // While recording the row looks armed, not merely selected: a hollow
                // outline plus the word "Press…" is unambiguous feedback that the next
                // key goes here and nowhere else.
                border: `1px solid ${
                  isRecording
                    ? ACCENT
                    : "color-mix(in oklab, " + ACCENT + " 40%, transparent)"
                }`,
                background: isRecording
                  ? "color-mix(in oklab, " + ACCENT + " 18%, transparent)"
                  : "color-mix(in oklab, " + ACCENT + " 10%, transparent)",
                color: "inherit",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                textAlign: "center",
                lineHeight: 1.6,
                whiteSpace: "nowrap",
              }}
            >
              {isRecording ? "Press…" : formatBinding(current)}
            </button>
          </div>
        );
      })}

      {notice ? (
        <div
          role="alert"
          style={{
            marginTop: 2,
            padding: "3px 4px",
            borderRadius: 4,
            background: "color-mix(in oklab, var(--color-danger-ink, #e5484d) 14%, transparent)",
            color: "var(--color-danger-ink, #e5484d)",
            lineHeight: 1.5,
            fontSize: 10,
          }}
        >
          {notice}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            props.onResetAll();
          }}
          style={{
            flex: 1,
            padding: "4px 0",
            borderRadius: 6,
            border: "1px solid var(--color-border, rgba(127,127,127,0.3))",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          Reset all
        </button>
      </div>

      {/*
        Why some keys are absent from the list above.
        A configurable system raises "where is my shortcut?" immediately, and answering
        it here is cheaper than answering it per user.
      */}
      <details style={{ marginTop: 6 }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: 10,
            opacity: 0.55,
            listStyle: "none",
            padding: "2px 0",
          }}
        >
          Keys that stay fixed
        </summary>
        <div style={{ display: "grid", gap: 3, padding: "2px 0 0" }}>
          {props.reserved.map((entry) => (
            <div key={entry.keys} style={{ display: "flex", gap: 6, lineHeight: 1.5 }}>
              <kbd style={reservedKbdStyle}>{entry.keys}</kbd>
              <span style={{ flex: 1, opacity: 0.6, fontSize: 10 }}>{entry.owner}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

const reservedKbdStyle: React.CSSProperties = {
  minWidth: 60,
  padding: "0 4px",
  borderRadius: 3,
  border: "1px solid var(--color-border, rgba(127,127,127,0.3))",
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 9,
  textAlign: "center",
  lineHeight: 1.6,
  opacity: 0.7,
  alignSelf: "flex-start",
};

/** Re-exported so the sprite does not have to import two modules for one row. */
export type { Binding, CommandId };
