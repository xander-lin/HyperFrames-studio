import { afterEach, describe, expect, it, vi } from "vitest";
import { pickBestSession, viewedAt } from "./sessionTarget.js";
import { collectFrameAttachments, injectAll, injectPayload, resolveTargetSession } from "./injector.js";

/** Record calls and simulate the OpenCode plugin context. */
function fakeCtx(sessions: unknown[] = []) {
  const calls = {
    create: [] as unknown[],
    prompt: [] as unknown[],
  };
  const ctx = {
    session: {
      // v2 returns `{ data, cursor }`; the input is typed so tests can assert on it.
      list: async (_input?: { directory?: string; limit?: number }) => ({
        data: sessions,
        cursor: {},
      }),
      get: async ({ sessionID }: { sessionID: string }) => session({ id: sessionID }),
      create: async (input: unknown) => {
        calls.create.push(input);
        return { id: "ses_new" };
      },
      prompt: async (input: unknown) => {
        calls.prompt.push(input);
        return { ok: true };
      },
    },
  };
  return { ctx, calls };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    prompt: "the rendered prompt",
    bundle: {
      projectDir: "/projects/demo",
      projectId: "demo",
      summary: "",
      annotations: [{}],
    },
    ...over,
  };
}

function session(over = {}) {
  return {
    id: "ses_1",
    location: { directory: "/projects/demo" },
    model: { id: "m", providerID: "p" },
    time: { updated: 100 },
    ...over,
  };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("viewedAt", () => {
  it("prefers viewed over updated", () => {
    expect(viewedAt({ id: "a", time: { viewed: 500, updated: 900 } })).toBe(500);
  });

  it("falls back to updated when an older session has no viewed", () => {
    // No `viewed` is not "never seen"; `updated` is far more useful than 0.
    expect(viewedAt({ id: "a", time: { updated: 700 } })).toBe(700);
  });

  it("returns 0 when neither timestamp exists", () => {
    expect(viewedAt({ id: "a" })).toBe(0);
  });
});

describe("pickBestSession", () => {
  const now = 1_800_000_000_000;

  it("picks the session the user last LOOKED AT, not the last one written to", () => {
    /*
     * This is the entire reason this module exists.
     *
     * A background session gets a newer `updated` whenever it receives an event.
     * Ordering by updated picks "the session running a task in the background"
     * while the user is watching another — the annotation lands in the wrong place.
     */
    const background = session({
      id: "ses_background",
      time: { viewed: now - 10 * MINUTE, updated: now - 1000 }, // just written, not being watched
    });
    const foreground = session({
      id: "ses_foreground",
      time: { viewed: now - 1000, updated: now - 30 * MINUTE }, // being watched
    });

    const picked = pickBestSession([background, foreground], "/projects/demo", now);
    expect(picked?.id).toBe("ses_foreground");
  });

  it("ignores sessions in a different project", () => {
    const picked = pickBestSession(
      [
        session({ id: "ses_other", location: { directory: "/projects/other" }, time: { viewed: now } }),
        session({ id: "ses_here", time: { viewed: now - HOUR } }),
      ],
      "/projects/demo",
      now,
    );
    expect(picked?.id).toBe("ses_here");
  });

  it("skips a session with no model, because prompt() would hang on it", () => {
    // found.md F-004: prompting an empty session with no model blocks forever.
    const picked = pickBestSession(
      [
        session({ id: "ses_empty", model: undefined, time: { viewed: now } }),
        session({ id: "ses_ready", time: { viewed: now - HOUR } }),
      ],
      "/projects/demo",
      now,
    );
    expect(picked?.id).toBe("ses_ready");
  });

  it("treats a trailing separator as the same directory", () => {
    const picked = pickBestSession(
      [session({ id: "ses_a", location: { directory: "/projects/demo/" }, time: { viewed: now } })],
      "/projects/demo",
      now,
    );
    expect(picked?.id).toBe("ses_a");
  });

  it("returns null when the project has no usable session", () => {
    expect(pickBestSession([], "/projects/demo", now)).toBeNull();
    expect(
      pickBestSession([session({ model: undefined })], "/projects/demo", now),
    ).toBeNull();
  });

  it("prefers a recently viewed session over a stale one from long ago", () => {
    // A session viewed last week must not outrank one used today.
    const stale = session({ id: "ses_stale", time: { viewed: now - 7 * 24 * HOUR, updated: now - 7 * 24 * HOUR } });
    const recent = session({ id: "ses_recent", time: { viewed: now - 3 * HOUR, updated: now - 3 * HOUR } });
    expect(pickBestSession([stale, recent], "/projects/demo", now)?.id).toBe("ses_recent");
  });

  it("falls back to updated ordering when no session was viewed recently", () => {
    // Nothing was viewed recently (right after a reboot, say): `updated` is then the
    // only usable signal.
    const older = session({ id: "ses_older", time: { updated: now - 5 * HOUR } });
    const newer = session({ id: "ses_newer", time: { updated: now - 2 * HOUR } });
    expect(pickBestSession([older, newer], "/projects/demo", now)?.id).toBe("ses_newer");
  });

  it("is deterministic when timestamps tie", () => {
    const a = session({ id: "ses_a", time: { viewed: now, updated: 1 } });
    const b = session({ id: "ses_b", time: { viewed: now, updated: 2 } });
    // Ties break on `updated` so the order does not drift with array order.
    expect(pickBestSession([a, b], "/projects/demo", now)?.id).toBe("ses_b");
  });
});

describe("resolveTargetSession", () => {
  it("reuses the session the user is looking at", async () => {
    const { ctx } = fakeCtx([
      session({ id: "ses_old", time: { viewed: 100 } }),
      session({ id: "ses_here", time: { viewed: 900 } }),
    ]);
    await expect(resolveTargetSession(ctx, "/projects/demo")).resolves.toMatchObject({
      sessionID: "ses_here",
      created: false,
    });
  });

  it("prefers the live session.viewed signal over the timestamp comparison", async () => {
    /*
     * The list says `ses_here` was viewed later, but the event stream says the user has
     * since opened `ses_open`. The live fact wins: it is the difference between "looked
     * at recently" and "is looking at right now".
     */
    const { ctx } = fakeCtx([
      session({ id: "ses_here", time: { viewed: 900 } }),
      session({ id: "ses_open", time: { viewed: 100 } }),
    ]);
    await expect(
      resolveTargetSession(ctx, "/projects/demo", undefined, { lastViewedSessionID: "ses_open" }),
    ).resolves.toMatchObject({ sessionID: "ses_open", reason: "last-viewed" });
  });

  it("ignores a viewed session that belongs to another project", async () => {
    // The user may have a second window open on a different project; it must not
    // receive this project's annotations.
    const { ctx } = fakeCtx([
      session({ id: "ses_here" }),
      session({ id: "ses_elsewhere", location: { directory: "/projects/other" } }),
    ]);
    await expect(
      resolveTargetSession(ctx, "/projects/demo", undefined, {
        lastViewedSessionID: "ses_elsewhere",
      }),
    ).resolves.toMatchObject({ sessionID: "ses_here" });
  });

  it("fetches a viewed session the list page did not include", async () => {
    /*
     * The list is filtered and paged; a session the event stream just named may fall
     * outside it. Asking for that one id directly keeps the strongest signal instead of
     * silently falling back.
     */
    const { ctx } = fakeCtx([session({ id: "ses_here" })]);
    const lookedup: string[] = [];
    ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
      lookedup.push(sessionID);
      return session({ id: sessionID, time: { viewed: 1 } });
    };
    await expect(
      resolveTargetSession(ctx, "/projects/demo", undefined, { lastViewedSessionID: "ses_deep" }),
    ).resolves.toMatchObject({ sessionID: "ses_deep", reason: "last-viewed" });
    expect(lookedup).toEqual(["ses_deep"]);
  });

  it("asks the server to filter by directory instead of paging an unfiltered list", async () => {
    /*
     * Filtering only in this process meant the project's sessions had to appear in the
     * first page of *every* session on the machine. On a long-lived installation they do
     * not, and the lookup silently found nothing.
     */
    const { ctx } = fakeCtx([session()]);
    const calls: unknown[] = [];
    ctx.session.list = async (input: unknown) => {
      calls.push(input);
      return { data: [session()], cursor: {} };
    };
    await resolveTargetSession(ctx, "/projects/demo");
    expect(calls[0]).toMatchObject({ directory: "/projects/demo" });
  });

  it("reports the session title, so the interface can name the destination", async () => {
    const { ctx } = fakeCtx([session({ id: "ses_here", title: "AVL rotations" })]);
    await expect(resolveTargetSession(ctx, "/projects/demo")).resolves.toMatchObject({
      title: "AVL rotations",
    });
  });

  it("honours an explicitly pinned session without checking the directory", async () => {
    /*
     * Pinning an annotation to a session is an explicit intent. Crossing directories
     * must be allowed too — refusing an explicit choice is more confusing than
     * honouring it.
     */
    const { ctx } = fakeCtx([
      session({ id: "ses_pinned", location: { directory: "/projects/other" } }),
      session({ id: "ses_here" }),
    ]);
    await expect(resolveTargetSession(ctx, "/projects/demo", "ses_pinned")).resolves.toMatchObject({
      sessionID: "ses_pinned",
      reason: "pinned",
    });
  });

  it("falls back to auto-selection when the pinned session no longer exists", async () => {
    // A stale pin must not make every delivery fail. The pin is fetched by id first (it may
    // legitimately live outside this project), so the lookup is what reports "gone".
    const { ctx } = fakeCtx([session({ id: "ses_here" })]);
    ctx.session.get = async () => {
      throw new Error("not found");
    };
    await expect(resolveTargetSession(ctx, "/projects/demo", "ses_gone")).resolves.toMatchObject({
      sessionID: "ses_here",
      reason: "most-recently-viewed",
    });
  });

  it("honours a pin for a session outside this project's page", async () => {
    /*
     * Subscription fan-out always pins, and the pinned session is looked up directly
     * rather than searched for in a directory-filtered page — otherwise a subscriber whose
     * session fell off the page would be silently redirected.
     */
    const { ctx } = fakeCtx([session({ id: "ses_here" })]);
    ctx.session.get = async ({ sessionID }: { sessionID: string }) => session({ id: sessionID });
    await expect(resolveTargetSession(ctx, "/projects/demo", "ses_deep")).resolves.toMatchObject({
      sessionID: "ses_deep",
      reason: "pinned",
    });
  });

  it("creates a session when the project has none", async () => {
    const { ctx, calls } = fakeCtx([]);
    await expect(resolveTargetSession(ctx, "/projects/demo")).resolves.toMatchObject({
      sessionID: "ses_new",
      created: true,
      reason: "created",
    });
    expect(calls.create[0]).toMatchObject({ location: { directory: "/projects/demo" } });
  });

  it("fails loudly when OpenCode returns no session id", async () => {
    const { ctx } = fakeCtx([]);
    ctx.session.create = async () => ({} as unknown as { id: string });
    await expect(resolveTargetSession(ctx, "/projects/demo")).rejects.toThrow("returned no session id");
  });

  it("still delivers when session.list fails, by creating a fresh session", async () => {
    const { ctx } = fakeCtx([]);
    ctx.session.list = async () => {
      throw new Error("boom");
    };
    await expect(resolveTargetSession(ctx, "/projects/demo")).resolves.toMatchObject({
      sessionID: "ses_new",
      created: true,
    });
  });
});

describe("injectPayload", () => {
  it("queues the prompt without auto-resuming, so the user stays in control", async () => {
    const { ctx, calls } = fakeCtx([session()]);
    await injectPayload(ctx, payload());
    expect(calls.prompt[0]).toMatchObject({
      sessionID: "ses_1",
      text: "the rendered prompt",
      delivery: "queue",
      resume: false,
    });
  });

  it("uses steer only when the caller explicitly asks for an immediate run", async () => {
    const { ctx, calls } = fakeCtx([session()]);
    await injectPayload(ctx, payload(), { mode: "run" });
    expect(calls.prompt[0]).toMatchObject({ delivery: "steer" });
    expect(calls.prompt[0]).not.toHaveProperty("resume");
  });

  it("passes the pinned session through to the prompt call", async () => {
    const { ctx, calls } = fakeCtx([
      session({ id: "ses_here" }),
      session({ id: "ses_pinned", location: { directory: "/elsewhere" } }),
    ]);
    await injectPayload(ctx, payload({ targetSessionID: "ses_pinned" }));
    expect(calls.prompt[0]).toMatchObject({ sessionID: "ses_pinned" });
  });

  it("refuses a payload with no project directory", async () => {
    const { ctx } = fakeCtx([session()]);
    await expect(
      injectPayload(ctx, {
        schemaVersion: 1,
        prompt: "x",
        bundle: { projectDir: "", projectId: "d", summary: "", annotations: [] },
      }),
    ).rejects.toThrow("no project directory");
  });
});

describe("collectFrameAttachments", () => {
  it("attaches each captured frame as a file the agent can open", () => {
    /*
     * The prompt text names captures by absolute path, but an agent that never opens
     * the image gets far less out of the annotation. Attaching them puts the picture
     * in front of the model directly.
     */
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/projects/demo",
          projectId: "demo",
          summary: "",
          annotations: [
            { id: "a1", frameImagePath: "/tmp/frames/ann_1.png" },
            { id: "a2", frameImagePath: "/tmp/frames/ann 2.png" },
          ],
        },
      }),
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      uri: "file:///tmp/frames/ann_1.png",
      source: { type: "uri", uri: "file:///tmp/frames/ann_1.png" },
      name: "annotation-1.png",
    });
    // A space in the path must be percent-encoded to stay a valid URI.
    expect(files[1]?.uri).toBe("file:///tmp/frames/ann%202.png");
  });

  it("skips annotations with no capture instead of sending an empty attachment", () => {
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/projects/demo",
          projectId: "demo",
          summary: "",
          annotations: [{ id: "a1" }, { id: "a2", frameImagePath: "/tmp/b.png" }],
        },
      }),
    );
    expect(files).toHaveLength(1);
    // Numbering follows the annotation, so the agent can map it to the prompt block.
    expect(files[0]?.name).toBe("annotation-2.png");
  });

  it("skips a relative path, which OpenCode cannot resolve against any fixed directory", () => {
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/projects/demo",
          projectId: "demo",
          summary: "",
          annotations: [{ id: "a1", frameImagePath: "frames/a.png" }],
        },
      }),
    );
    expect(files).toEqual([]);
  });

  it("passes an existing file:// URI through untouched", () => {
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/p",
          projectId: "p",
          summary: "",
          annotations: [{ id: "a1", frameImagePath: "file:///tmp/a.png" }],
        },
      }),
    );
    expect(files[0]?.uri).toBe("file:///tmp/a.png");
  });
});

describe("collectFrameAttachments — handwriting", () => {
  it("attaches the composed handwriting image, because the picture is the message", () => {
    /*
     * Ink has no block reference and no coordinates worth reading. What the reader needs
     * is to see the frame with the strokes on it, so this attachment is not evidence
     * for a mark — it is the mark.
     */
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/projects/demo",
          projectId: "demo",
          summary: "",
          annotations: [],
          ink: [{ compositionPath: "index.html", time: 2, imagePath: "/tmp/frames/ink_abc.png" }],
        },
      }),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      uri: "file:///tmp/frames/ink_abc.png",
      name: "handwriting-1.png",
    });
    expect(files[0]?.description).toContain("wrote on it");
  });

  it("puts numbered captures before handwriting, so references resolve first", () => {
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/p",
          projectId: "p",
          summary: "",
          annotations: [{ id: "a1", frameImagePath: "/tmp/a.png" }],
          ink: [{ compositionPath: "index.html", time: 1, imagePath: "/tmp/ink.png" }],
        },
      }),
    );
    expect(files.map((file) => file.name)).toEqual(["annotation-1.png", "handwriting-1.png"]);
  });

  it("skips a handwriting entry with no path", () => {
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/p",
          projectId: "p",
          summary: "",
          annotations: [],
          ink: [{ compositionPath: "index.html", time: 1, imagePath: "" }],
        },
      }),
    );
    expect(files).toEqual([]);
  });

  it("still works for a payload with no ink field at all", () => {
    // Older senders do not have it; absence must not throw.
    const files = collectFrameAttachments(
      payload({
        bundle: {
          projectDir: "/p",
          projectId: "p",
          summary: "",
          annotations: [{ id: "a1", frameImagePath: "/tmp/a.png" }],
        },
      }),
    );
    expect(files).toHaveLength(1);
  });
});

describe("injectAll", () => {
  it("keeps going after one bad payload", async () => {
    const { ctx } = fakeCtx([session()]);
    const result = await injectAll(ctx, [
      payload({ prompt: "first" }),
      { schemaVersion: 1, prompt: "bad", bundle: { projectDir: "", projectId: "", summary: "", annotations: [] } },
      payload({ prompt: "third" }),
    ]);
    expect(result.delivered).toBe(2);
    expect(result.failures).toHaveLength(1);
  });
});
