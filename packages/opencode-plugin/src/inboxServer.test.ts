import { afterEach, describe, expect, it } from "vitest";
import { startInbox } from "./inboxServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
});

function fakeCtx(sessions: unknown[] = []) {
  const calls: unknown[] = [];
  return {
    calls,
    ctx: {
      session: {
        list: async () => ({ data: sessions }),
        create: async () => ({ id: "ses_created" }),
        prompt: async (input: unknown) => {
          calls.push(input);
          return { ok: true };
        },
      },
    },
  };
}

function payload() {
  return {
    schemaVersion: 1,
    prompt: "nudge the title left",
    bundle: {
      projectDir: "/projects/demo",
      projectId: "demo",
      summary: "",
      annotations: [{ id: "a1" }],
    },
  };
}

async function boot(sessions: unknown[] = []) {
  const { ctx, calls } = fakeCtx(sessions);
  // Port 0 lets the OS assign one, so parallel tests do not fight over it.
  const inbox = await startInbox({ ctx, port: 0 });
  cleanups.push(() => inbox.close());
  return { base: `http://127.0.0.1:${inbox.port}`, calls };
}

describe("inbox server", () => {
  it("answers a health check, so the desktop can tell it is alive", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("injects a valid payload and reports the target session", async () => {
    const { base, calls } = await boot([
      {
        id: "ses_1",
        location: { directory: "/projects/demo" },
        model: { id: "m" },
        time: { updated: 5 },
      },
    ]);
    const response = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload()),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionID: "ses_1" });
    expect(calls[0]).toMatchObject({ text: "nudge the title left", delivery: "queue", resume: false });
  });

  it("rejects malformed json with 400, not a crash", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a payload with nothing in it at all", async () => {
    const { base } = await boot();
    const bad = { ...payload(), bundle: { projectDir: "/p", annotations: [] } };
    const response = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("No annotations");
  });

  it("accepts a handwriting-only payload", async () => {
    /*
     * Ink has no block reference, so a frame the user only drew on produces no
     * annotation — and the picture of that frame is the entire message. Requiring an
     * annotation rejected exactly the "I just scribbled on this frame" case the desktop
     * had already accepted.
     */
    const { base, calls } = await boot([
      {
        id: "ses_1",
        location: { directory: "/projects/demo" },
        model: { id: "m" },
        time: { updated: 5 },
      },
    ]);
    const inkOnly = {
      ...payload(),
      bundle: {
        projectDir: "/projects/demo",
        projectId: "demo",
        summary: "",
        annotations: [],
        ink: [{ compositionPath: "index.html", time: 1, imagePath: "/tmp/ink-1.png" }],
      },
    };
    const response = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inkOnly),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects a payload with no prompt text", async () => {
    const { base } = await boot();
    const bad = { ...payload(), prompt: "   " };
    const response = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(response.status).toBe(400);
  });

  it("404s unknown paths instead of treating them as annotations", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/whatever`);
    expect(response.status).toBe(404);
  });

  it("surfaces an injection failure as 500 with the reason", async () => {
    const { ctx } = fakeCtx([]);
    ctx.session.create = async () => {
      throw new Error("create failed");
    };
    const inbox = await startInbox({ ctx, port: 0 });
    cleanups.push(() => inbox.close());
    const response = await fetch(`http://127.0.0.1:${inbox.port}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload()),
    });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("create failed");
  });
});
