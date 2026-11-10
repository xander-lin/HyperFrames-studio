import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOutboxSink, addSubscription, publishPresence } from "@mystudio/protocol/node";
import type { AnnotationBundle } from "@mystudio/protocol";
import { SubscribedSink } from "./subscribedSink.js";

/**
 * Fan-out delivery, and what happens when nobody is listening.
 *
 * The three states that must be distinguishable:
 * - **subscribed**: delivered, and the outcome names every recipient;
 * - **nobody subscribed**: queued loudly, never silently dropped, never called "sent";
 * - **subscriber unreachable**: also queued, with the reason, because the plugin may just
 *   be restarting.
 */

let root: string;
let outboxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mystudio-sink-"));
  outboxDir = await mkdtemp(join(tmpdir(), "mystudio-outbox-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outboxDir, { recursive: true, force: true });
});

function bundle(): AnnotationBundle {
  return {
    schemaVersion: 1,
    projectDir: "/projects/demo",
    projectId: "demo",
    summary: "",
    annotations: [
      {
        id: "a1",
        shape: { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        frame: { compositionPath: "index.html", time: 1, compositionWidth: 1920, compositionHeight: 1080 },
        note: "",
        createdAt: 1,
      },
    ],
    createdAt: 1,
  };
}

async function subscribe(sessionID: string, pluginEndpoint: string, title?: string) {
  await publishPresence(
    {
      version: 1,
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "demo",
      endpoint: "http://127.0.0.1:4317",
      pid: 1,
      startedAt: 1,
      heartbeatAt: Date.now(),
    },
    root,
  );
  await addSubscription(
    {
      version: 1,
      appId: "app_1",
      projectDir: "/projects/demo",
      sessionID,
      pluginEndpoint,
      createdAt: 1,
      ...(title ? { sessionTitle: title } : {}),
    },
    root,
  );
}

function sink(fetchImpl: typeof fetch) {
  return new SubscribedSink({
    appId: "app_1",
    projectDir: "/projects/demo",
    root,
    outbox: new FileOutboxSink({ dir: outboxDir }),
    fetchImpl,
  });
}

describe("after a restart", () => {
  it("still delivers to a subscription made by an earlier launch of the project", async () => {
    /*
     * The reported failure, end to end: subscribe in a conversation, restart MyStudio, send.
     * The launch id changed, so a lookup keyed only by it found nothing and the delivery was
     * queued instead of arriving (found.md F-098).
     */
    await publishPresence(
      {
        version: 1,
        appId: "app_old",
        projectDir: "/projects/demo",
        projectName: "demo",
        endpoint: "http://127.0.0.1:4317",
        pid: 1,
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
      root,
    );
    await addSubscription(
      {
        version: 1,
        appId: "app_old",
        projectDir: "/projects/demo",
        sessionID: "ses_1",
        pluginEndpoint: "http://127.0.0.1:47812",
        createdAt: 1,
      },
      root,
    );

    // A different launch of the same project.
    const fresh = new SubscribedSink({
      appId: "app_new",
      projectDir: "/projects/demo",
      root,
      outbox: new FileOutboxSink({ dir: outboxDir }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const result = await fresh.deliver(bundle(), "p");

    expect(result.ok && result.targets?.map((t) => t.sessionID)).toEqual(["ses_1"]);
    expect(await readdir(outboxDir)).toEqual([]);
  });

  it("does not borrow a subscription from another project", async () => {
    await publishPresence(
      {
        version: 1,
        appId: "app_other",
        projectDir: "/projects/other",
        projectName: "other",
        endpoint: "http://127.0.0.1:4317",
        pid: 1,
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
      root,
    );
    await addSubscription(
      {
        version: 1,
        appId: "app_other",
        projectDir: "/projects/other",
        sessionID: "ses_other",
        pluginEndpoint: "http://127.0.0.1:47812",
        createdAt: 1,
      },
      root,
    );

    const sink = new SubscribedSink({
      appId: "app_new",
      projectDir: "/projects/demo",
      root,
      outbox: new FileOutboxSink({ dir: outboxDir }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const result = await sink.deliver(bundle(), "p");

    // Nobody subscribed to *this* project, so it queues.
    expect(result.ok && result.targets).toBeUndefined();
    expect(await readdir(outboxDir)).toHaveLength(1);
  });

  it("records the app id with a queued delivery", async () => {
    // Without it, replay cannot know whose subscribers to use.
    const sink = new SubscribedSink({
      appId: "app_1",
      projectDir: "/projects/demo",
      root,
      outbox: new FileOutboxSink({ dir: outboxDir }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await sink.deliver(bundle(), "p");

    const [name] = await readdir(outboxDir);
    const record = JSON.parse(await readFile(join(outboxDir, name!), "utf8"));
    expect(record.appId).toBe("app_1");
  });
});

describe("no subscribers", () => {
  it("queues instead of failing, and does not claim it was delivered", async () => {
    const result = await sink(async () => new Response("{}")).deliver(bundle(), "p");

    expect(result.ok).toBe(true);
    expect(result.ok && result.target).toBeUndefined();
    expect(result.ok && result.detail).toContain("outbox");
    expect(await readdir(outboxDir)).toHaveLength(1);
  });

  it("narrows to one subscriber when a pin is given, but never invents one", async () => {
    /*
     * A pin can only restrict the fan-out. If the named session is not subscribed there is
     * no endpoint to post to, and guessing one is the behaviour this design removed.
     */
    await subscribe("ses_1", "http://127.0.0.1:47812");
    let called = false;
    const result = await sink(async () => {
      called = true;
      return new Response("{}");
    }).deliver(bundle(), "p", { targetSessionID: "ses_other" });

    expect(called).toBe(false);
    expect(result.ok && result.detail).toContain("ses_other");
  });
});

describe("fan-out", () => {
  it("delivers to every subscriber and names them", async () => {
    await subscribe("ses_1", "http://127.0.0.1:47812", "AVL rotations");
    await subscribe("ses_2", "http://127.0.0.1:47813", "Notes");

    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await sink(async (input, init) => {
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    }).deliver(bundle(), "the prompt");

    expect(result.ok).toBe(true);
    expect(posts.map((post) => post.url)).toEqual([
      "http://127.0.0.1:47812/annotations",
      "http://127.0.0.1:47813/annotations",
    ]);
    // Each request pins its own session: the plugin must not re-decide.
    expect(posts.map((post) => post.body["targetSessionID"])).toEqual(["ses_1", "ses_2"]);
    expect(result.ok && result.targets?.map((target) => target.title)).toEqual([
      "AVL rotations",
      "Notes",
    ]);
  });

  it("pins only the named session when the caller asks for one", async () => {
    await subscribe("ses_1", "http://127.0.0.1:47812");
    await subscribe("ses_2", "http://127.0.0.1:47813");

    const urls: string[] = [];
    await sink(async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }).deliver(bundle(), "p", { targetSessionID: "ses_2" });

    expect(urls).toEqual(["http://127.0.0.1:47813/annotations"]);
  });

  it("still delivers to the rest when one subscriber is unreachable", async () => {
    await subscribe("ses_1", "http://127.0.0.1:47812");
    await subscribe("ses_2", "http://127.0.0.1:47813");

    const result = await sink(async (input) => {
      if (String(input).includes("47813")) throw new TypeError("connection refused");
      return new Response("{}", { status: 200 });
    }).deliver(bundle(), "p");

    expect(result.ok).toBe(true);
    expect(result.ok && result.targets).toHaveLength(1);
    expect(result.ok && result.detail).toContain("1 unreachable");
    // A partial success must not be queued: the outbox record would be delivered twice to
    // the conversation that already received it.
    expect(await readdir(outboxDir)).toEqual([]);
  });
});

describe("every subscriber unreachable", () => {
  it("queues and reports why, because the plugin may be restarting", async () => {
    await subscribe("ses_1", "http://127.0.0.1:47812");

    const result = await sink(async () => {
      throw new TypeError("connection refused");
    }).deliver(bundle(), "p");

    expect(result.ok).toBe(true);
    expect(result.ok && result.targets).toBeUndefined();
    expect(result.ok && result.detail).toContain("connection refused");
    expect(await readdir(outboxDir)).toHaveLength(1);
  });

  it("fails loudly when the outbox cannot be written either", async () => {
    await subscribe("ses_1", "http://127.0.0.1:47812");
    const broken = new SubscribedSink({
      appId: "app_1",
      projectDir: "/projects/demo",
      root,
      // A path that cannot be created: this exercises the "nothing saved" branch.
      outbox: new FileOutboxSink({ dir: "/proc/mystudio-cannot-write" }),
      fetchImpl: async () => {
        throw new TypeError("down");
      },
    });

    const result = await broken.deliver(bundle(), "p");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("unreachable");
  });
});
