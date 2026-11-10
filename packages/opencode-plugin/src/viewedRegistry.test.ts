import { describe, expect, it } from "vitest";
import {
  createViewedRegistry,
  trackViewedSessions,
  viewedSessionID,
} from "./viewedRegistry.js";

/**
 * The live "which window is the user in" signal.
 *
 * OpenCode runs one server process for every window, so a plugin cannot read the focused
 * window. `session.viewed` is the only fact available, and it arrives as an event — so the
 * rule is worth testing without any server: feed events, read the latest.
 */

const viewed = (sessionID: string) => ({
  type: "session.viewed" as const,
  data: { sessionID, idle: 0 },
});

describe("viewedSessionID", () => {
  it("reads the id from a session.viewed event", () => {
    expect(viewedSessionID(viewed("ses_1"))).toBe("ses_1");
  });

  it("ignores every other event type", () => {
    expect(viewedSessionID({ type: "session.updated", data: { sessionID: "ses_1" } })).toBeNull();
  });

  it("ignores malformed events instead of throwing", () => {
    expect(viewedSessionID(null)).toBeNull();
    expect(viewedSessionID({ type: "session.viewed", data: {} })).toBeNull();
    expect(viewedSessionID({ type: "session.viewed", data: { sessionID: "" } })).toBeNull();
  });
});

describe("createViewedRegistry", () => {
  it("starts empty: no delivery has seen the user look at anything", () => {
    expect(createViewedRegistry().last()).toBeNull();
  });

  it("keeps the most recent view, not the first", () => {
    const registry = createViewedRegistry();
    registry.note(viewed("ses_first"));
    registry.note(viewed("ses_second"));
    expect(registry.last()?.sessionID).toBe("ses_second");
  });

  it("does not change on an unrelated event", () => {
    const registry = createViewedRegistry();
    registry.note(viewed("ses_here"));
    expect(registry.note({ type: "session.created", data: { sessionID: "ses_new" } })).toBe(false);
    expect(registry.last()?.sessionID).toBe("ses_here");
  });

  it("can be cleared when the session disappears", () => {
    const registry = createViewedRegistry();
    registry.note(viewed("ses_here"));
    registry.clear();
    expect(registry.last()).toBeNull();
  });
});

describe("trackViewedSessions", () => {
  it("does nothing when the host has no event domain", () => {
    // Older hosts and test contexts lack it; delivery still works from the list.
    const registry = createViewedRegistry();
    const stop = trackViewedSessions({ session: {} }, registry);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("feeds events into the registry until stopped", async () => {
    const registry = createViewedRegistry();
    const events = [viewed("ses_1"), viewed("ses_2")];
    const ctx = {
      event: {
        subscribe: async function* () {
          for (const event of events) yield event;
        },
      },
    };
    const stop = trackViewedSessions(ctx, registry);
    // Let the detached loop run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.last()?.sessionID).toBe("ses_2");
    stop();
  });

  it("survives a subscription that throws", async () => {
    const registry = createViewedRegistry();
    const logged: string[] = [];
    const ctx = {
      event: {
        subscribe: () => {
          throw new Error("boom");
        },
      },
    };
    // Must not reject or throw: a broken subscription cannot break delivery.
    const stop = trackViewedSessions(ctx, registry, (msg) => logged.push(msg));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logged.join(" ")).toContain("subscription ended");
    stop();
  });
});
