/**
 * Which conversations receive this app's annotations.
 *
 * ## Read-only on purpose
 *
 * A subscription is created **from inside the conversation that wants the annotations**: the
 * agent there runs `mystudio_subscribe`. That is the whole point of the design — the
 * conversation declares itself, so nothing has to guess which window is meant, and several
 * conversations can subscribe to the same app and all receive it.
 *
 * So this panel does not offer a picker. It answers the two questions the user actually has:
 * **is anyone listening**, and **who**. A picker here would reintroduce exactly the
 * "app chooses the conversation" model that the subscription replaced.
 */

import { useCallback, useEffect, useState } from "react";
import type { SubscriberSummary } from "@mystudio/protocol";
import { BRIDGE_ROUTES } from "@mystudio/protocol";

const ACCENT = "var(--color-accent, #37b878)";

export interface SubscriberPanelProps {
  /** The session that received the most recent delivery, if any. */
  readonly lastDelivery?: { readonly sessionID: string; readonly title?: string } | null;
}

export function SubscriberPanel(props: SubscriberPanelProps) {
  const [subscribers, setSubscribers] = useState<readonly SubscriberSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(BRIDGE_ROUTES.subscribers, {
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (isSubscribersResponse(body)) {
        if (body.ok) {
          setSubscribers(body.subscribers);
          setError(null);
        } else {
          setSubscribers([]);
          setError(body.error);
        }
      } else {
        setSubscribers([]);
        setError(`The host answered HTTP ${response.status}`);
      }
    } catch (failure) {
      setSubscribers([]);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div data-mystudio-overlay="subscriber-panel" style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={headingStyle}>Conversations</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          title="Re-read the subscribers"
          aria-label="Refresh subscribers"
          style={refreshStyle(busy)}
        >
          ↻
        </button>
      </div>

      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : null}

      {subscribers.map((subscriber) => {
        const isLast = props.lastDelivery?.sessionID === subscriber.sessionID;
        return (
          <div
            key={subscriber.sessionID}
            data-mystudio-overlay="subscriber-row"
            title={subscriber.sessionID}
            style={{
              ...rowStyle,
              borderColor: `color-mix(in oklab, ${ACCENT} 35%, transparent)`,
              background: isLast ? `color-mix(in oklab, ${ACCENT} 12%, transparent)` : "transparent",
            }}
          >
            <span style={dotStyle(isLast)} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {subscriber.title ?? subscriber.sessionID}
            </span>
            {isLast ? (
              <span title="The most recent prompt went here" style={{ opacity: 0.5, fontSize: 9 }}>
                last
              </span>
            ) : null}
          </div>
        );
      })}

      {!busy && subscribers.length === 0 && !error ? (
        /*
         * The empty state has to teach the next step, because nothing here can create a
         * subscription. Naming the tool is the difference between "why is nothing
         * happening" and a thirty-second setup.
         */
        <div data-mystudio-overlay="subscriber-empty" style={emptyStyle}>
          No conversation is subscribed yet.
          <br />
          In OpenCode, ask the agent to run <code style={codeStyle}>mystudio_subscribe</code>.
        </div>
      ) : null}

      {!busy && subscribers.length > 0 ? (
        <div style={hintStyle}>
          Every annotation goes to {subscribers.length === 1 ? "this conversation" : "all of them"}.
        </div>
      ) : null}
    </div>
  );
}

function isSubscribersResponse(
  value: unknown,
): value is { ok: true; subscribers: SubscriberSummary[] } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["ok"] === true) return Array.isArray(record["subscribers"]);
  if (record["ok"] === false) return typeof record["error"] === "string";
  return false;
}

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const headingStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 10,
  letterSpacing: 0.4,
  opacity: 0.5,
  textTransform: "uppercase",
  padding: "2px 0",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "4px 6px",
  borderRadius: 6,
  border: "1px solid transparent",
  fontSize: 11,
};

function dotStyle(active: boolean): React.CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: 999,
    flex: "0 0 auto",
    background: active ? ACCENT : `color-mix(in oklab, ${ACCENT} 55%, transparent)`,
  };
}

function refreshStyle(busy: boolean): React.CSSProperties {
  return {
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: busy ? 0.3 : 0.55,
    cursor: busy ? "default" : "pointer",
    fontSize: 11,
    lineHeight: 1,
    padding: "0 2px",
  };
}

const emptyStyle: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.55,
  lineHeight: 1.7,
  padding: "2px",
};

const hintStyle: React.CSSProperties = {
  fontSize: 9,
  opacity: 0.4,
  lineHeight: 1.6,
  padding: "2px",
};

const codeStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 9,
  padding: "0 3px",
  borderRadius: 3,
  background: "color-mix(in oklab, currentColor 12%, transparent)",
};

const errorStyle: React.CSSProperties = {
  padding: "3px 4px",
  borderRadius: 4,
  background: "color-mix(in oklab, var(--color-danger-ink, #e5484d) 14%, transparent)",
  color: "var(--color-danger-ink, #e5484d)",
  lineHeight: 1.5,
  fontSize: 10,
};
