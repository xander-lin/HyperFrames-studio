import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainOutbox, outboxDirsFor, startOutboxDrain } from "./outbox.js";
import { addSubscription, publishPresence, type AppPresence } from "@mystudio/protocol/node";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mystudio-outbox-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface PromptCall {
  sessionID: string;
  text: string;
  delivery?: "queue" | "steer";
  resume?: boolean;
}

function payload(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    prompt: "nudge the title right",
    bundle: {
      projectDir: "/projects/demo",
      projectId: "demo",
      summary: "",
      annotations: [{ id: "a1" }],
    },
    ...over,
  };
}

function fakeCtx(
  { sessions = [], promptFails = false }: { sessions?: unknown[]; promptFails?: boolean } = {},
) {
  const prompts: PromptCall[] = [];
  const ctx = {
    session: {
      list: async () => ({ data: sessions }),
      create: async () => ({ id: "ses_created" }),
      prompt: async (input: PromptCall) => {
        if (promptFails) throw new Error("prompt failed");
        prompts.push(input);
        return { ok: true };
      },
    },
    model: { default: async () => ({}) },
    agent: { list: async () => ({ data: [] }) },
  };
  return { ctx, prompts };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: "ses_1",
    location: { directory: "/projects/demo" },
    model: { id: "m" },
    time: { updated: 100 },
    ...over,
  };
}

/**
 * A registry root with one live app and one subscription to it.
 *
 * Delivery is by subscription now, so a queued payload with no subscriber is (correctly)
 * left alone — every test that expects delivery has to arrange a subscriber first.
 */
async function subscribedRegistry(
  options: { projectDir?: string; pluginEndpoint?: string; sessionID?: string; appId?: string } = {},
) {
  const root = await tempDir();
  const appId = options.appId ?? "app_test_1";
  const projectDir = options.projectDir ?? "/projects/demo";
  const pluginEndpoint = options.pluginEndpoint ?? "http://127.0.0.1:47812";
  const sessionID = options.sessionID ?? "ses_1";

  const presence: AppPresence = {
    version: 1,
    appId,
    projectDir,
    projectName: "demo",
    endpoint: "http://127.0.0.1:4317",
    pid: 1,
    startedAt: 1,
    heartbeatAt: Date.now(),
  };
  await publishPresence(presence, root);
  await addSubscription(
    {
      version: 1,
      appId,
      projectDir,
      sessionID,
      pluginEndpoint,
      createdAt: 1,
    },
    root,
  );
  // `ownEndpoint` is what the plugin believes its own inbox is; it must match the value
  // stored on the subscription or the record is (correctly) left for another instance.
  return { root, appId, pluginEndpoint, sessionID, ownEndpoint: pluginEndpoint };
}

async function writePayload(dir: string, name: string, body: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

describe("drainOutbox", () => {
  it("injects a waiting payload into the project session", async () => {
    const dir = await tempDir();
    await writePayload(dir, "2026-01-01T00-00-00Z_1.json", payload());
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    const result = await drainOutbox(ctx, dir, { ...registry });

    expect(result).toMatchObject({ delivered: 1, failed: 0, skipped: false });
    expect(prompts[0]).toMatchObject({
      sessionID: "ses_1",
      text: "nudge the title right",
      delivery: "queue",
      resume: false,
    });
  });

  it("leaves a payload queued when no conversation is subscribed", async () => {
    /*
     * Zero subscribers is a normal state (nobody has subscribed yet), not a failure: the
     * record must survive until someone does, and must not be parked in `rejected/` where
     * it would never be retried.
     */
    const dir = await tempDir();
    await writePayload(dir, "waiting.json", payload());
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });

    const result = await drainOutbox(ctx, dir, { ownEndpoint: "http://127.0.0.1:47812" });

    expect(result).toMatchObject({ delivered: 0, failed: 0 });
    expect(prompts).toHaveLength(0);
    expect(await readdir(dir)).toEqual(["waiting.json"]);
  });

  it("only delivers to subscribers of this plugin, leaving other servers' share queued", async () => {
    /*
     * A session subscribed through a *different* OpenCode server cannot be prompted from
     * here. Delivering anyway would fail, or worse, land in an unrelated session that
     * happens to share the id.
     */
    const dir = await tempDir();
    await writePayload(dir, "shared.json", payload());
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry({ pluginEndpoint: "http://127.0.0.1:47900" });

    const result = await drainOutbox(ctx, dir, {
      ...registry,
      ownEndpoint: "http://127.0.0.1:47812",
    });

    expect(result).toMatchObject({ delivered: 0, failed: 0 });
    expect(prompts).toHaveLength(0);
    expect(await readdir(dir)).toEqual(["shared.json"]);
  });

  it("delivers a record whose app has already gone away", async () => {
    /*
     * The reported failure: send, then MyStudio restarts before the plugin drains. The app
     * that wrote the record has no presence entry any more, so a lookup restricted to *live*
     * apps found nothing and the record sat in the outbox forever — while the conversation
     * that had subscribed was still open (found.md F-098).
     *
     * The subscription still names the app id and the project, so those are consulted too.
     */
    const dir = await tempDir();
    const root = await tempDir();
    const { addSubscription } = await import("@mystudio/protocol/node");

    // Subscription for a launch that is no longer running; no presence published for it.
    await addSubscription(
      {
        version: 1,
        appId: "app_gone",
        projectDir: "/projects/demo",
        sessionID: "ses_1",
        pluginEndpoint: "http://127.0.0.1:47812",
        createdAt: 1,
      },
      root,
    );

    await writePayload(dir, "queued.json", payload({ appId: "app_gone" }));
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });

    const result = await drainOutbox(ctx, dir, {
      root,
      ownEndpoint: "http://127.0.0.1:47812",
    });

    expect(result).toMatchObject({ delivered: 1, failed: 0 });
    expect(prompts[0]).toMatchObject({ sessionID: "ses_1" });
  });

  it("still refuses a subscription that belongs to another project", async () => {
    // The fallback must not become a hole: a record's project still constrains its targets.
    const dir = await tempDir();
    const root = await tempDir();
    const { addSubscription } = await import("@mystudio/protocol/node");
    await addSubscription(
      {
        version: 1,
        appId: "app_gone",
        projectDir: "/projects/other",
        sessionID: "ses_other",
        pluginEndpoint: "http://127.0.0.1:47812",
        createdAt: 1,
      },
      root,
    );

    await writePayload(dir, "queued.json", payload({ appId: "app_gone" }));
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const result = await drainOutbox(ctx, dir, { root, ownEndpoint: "http://127.0.0.1:47812" });

    expect(result).toMatchObject({ delivered: 0, failed: 0 });
    expect(prompts).toHaveLength(0);
  });

  it("treats a missing directory as nothing to do, not an error", async () => {
    const { ctx } = fakeCtx();
    const result = await drainOutbox(ctx, join(tmpdir(), "definitely-not-here-mystudio"));
    expect(result).toMatchObject({ delivered: 0, failed: 0, skipped: true });
  });

  it("processes several payloads oldest first", async () => {
    const dir = await tempDir();
    await writePayload(dir, "2026-01-01T00-00-02Z.json", payload({ prompt: "second" }));
    await writePayload(dir, "2026-01-01T00-00-01Z.json", payload({ prompt: "first" }));
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    await drainOutbox(ctx, dir, { ...registry });

    expect(prompts.map((p: PromptCall) => p.text)).toEqual(["first", "second"]);
  });

  it("archives a delivered payload into sent/ instead of deleting it", async () => {
    const dir = await tempDir();
    await writePayload(dir, "one.json", payload());
    const { ctx } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    await drainOutbox(ctx, dir, { ...registry });

    expect(await readdir(dir)).toEqual(["sent"]);
    expect(await readdir(join(dir, "sent"))).toEqual(["one.json"]);
  });

  it("returns a failed payload to its original name so the next round retries it", async () => {
    // A failed injection (no session could be created, say) must not swallow the
    // user's annotation.
    const dir = await tempDir();
    await writePayload(dir, "retry.json", payload());
    const { ctx } = fakeCtx({ promptFails: true });
    const registry = await subscribedRegistry();

    const result = await drainOutbox(ctx, dir, { ...registry });

    expect(result).toMatchObject({ delivered: 0, failed: 1 });
    expect(await readdir(dir)).toEqual(["retry.json"]);
  });

  it("parks a corrupt json in rejected/ so it does not wedge the queue", async () => {
    const dir = await tempDir();
    await writePayload(dir, "bad.json", "{not json");
    await writePayload(dir, "good.json", payload());
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    const result = await drainOutbox(ctx, dir, { ...registry });

    expect(result).toMatchObject({ delivered: 1, failed: 1 });
    expect(prompts).toHaveLength(1);
    // The good one is an audit record of something delivered; the corrupt one is kept
    // separately so it is never mistaken for a successful delivery.
    expect(await readdir(join(dir, "sent"))).toEqual(["good.json"]);
    expect(await readdir(join(dir, "rejected"))).toEqual(["bad.json"]);
  });

  it("parks a payload that fails the shared contract validation", async () => {
    const dir = await tempDir();
    await writePayload(dir, "empty.json", payload({ bundle: { projectDir: "/p", annotations: [] } }));
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    const result = await drainOutbox(ctx, dir, { ...registry });

    expect(result).toMatchObject({ delivered: 0, failed: 1 });
    expect(prompts).toHaveLength(0);
    expect(await readdir(join(dir, "rejected"))).toEqual(["empty.json"]);
  });

  it("ignores non-json files that share the directory", async () => {
    const dir = await tempDir();
    await writePayload(dir, "one.json", payload());
    await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    await drainOutbox(ctx, dir, { ...registry });

    expect(prompts).toHaveLength(1);
    expect(await readdir(dir)).toContain("notes.txt");
  });
});

describe("outboxDirsFor", () => {
  it("defaults to the opencode working directory", () => {
    const dirs = outboxDirsFor("/projects/demo");
    expect(dirs).toEqual([join("/projects/demo", ".mystudio", "outbox")]);
  });

  it("honours an explicit list for watching several projects at once", () => {
    const previous = process.env.MYSTUDIO_OUTBOX_DIRS;
    process.env.MYSTUDIO_OUTBOX_DIRS = "/a/.mystudio/outbox:/b/.mystudio/outbox";
    try {
      expect(outboxDirsFor("/ignored")).toEqual([
        "/a/.mystudio/outbox",
        "/b/.mystudio/outbox",
      ]);
    } finally {
      if (previous === undefined) delete process.env.MYSTUDIO_OUTBOX_DIRS;
      else process.env.MYSTUDIO_OUTBOX_DIRS = previous;
    }
  });

  it("returns nothing when there is no working directory to anchor to", () => {
    expect(outboxDirsFor("")).toEqual([]);
  });
});

describe("startOutboxDrain", () => {
  it("drains once immediately on start, then stops cleanly", async () => {
    const dir = await tempDir();
    await writePayload(dir, "one.json", payload());
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    const drain = startOutboxDrain(ctx, [dir], { intervalMs: 60_000, ...registry });
    // The immediate scan is asynchronous; give it one event loop turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    drain.stop();

    expect(prompts).toHaveLength(1);
  });

  it("keeps polling, so a payload written later is still picked up", async () => {
    const dir = await tempDir();
    const { ctx, prompts } = fakeCtx({ sessions: [session()] });
    const registry = await subscribedRegistry();

    const drain = startOutboxDrain(ctx, [dir], { intervalMs: 40, ...registry });
    await writePayload(dir, "late.json", payload());
    await new Promise((resolve) => setTimeout(resolve, 200));
    drain.stop();

    expect(prompts).toHaveLength(1);
  });

  it("does not stack overlapping scans", async () => {
    const dir = await tempDir();
    await writePayload(dir, "one.json", payload());
    let inFlight = 0;
    let maxInFlight = 0;
    const ctx = {
      session: {
        list: async () => ({ data: [session()] }),
        create: async () => ({ id: "s" }),
        prompt: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { ok: true };
      },
      },
      model: { default: async () => ({}) },
      agent: { list: async () => ({ data: [] }) },
    };

    const registry = await subscribedRegistry();
    const drain = startOutboxDrain(ctx, [dir], { intervalMs: 10, ...registry });
    await new Promise((resolve) => setTimeout(resolve, 250));
    drain.stop();

    expect(maxInFlight).toBe(1);
  });
});
