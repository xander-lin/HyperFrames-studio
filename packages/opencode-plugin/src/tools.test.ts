import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listSubscriptions,
  publishPresence,
  subscriptionsOfSession,
  type AppPresence,
} from "@mystudio/protocol/node";
import { registerTools } from "./tools.js";

/**
 * The tools as the agent actually gets them.
 *
 * The host `await`s `execute` and expects a `Promise`, so these tests **await the tool the
 * way the host does**. A wrong shape here fails at runtime, in the middle of a user's
 * conversation — which is exactly how the Effect/Promise mismatch was found (found.md F-088).
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mystudio-tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app(over: Partial<AppPresence> = {}): AppPresence {
  return {
    version: 1,
    appId: "app_1",
    projectDir: "/projects/demo",
    projectName: "demo",
    endpoint: "http://127.0.0.1:4317",
    pid: 1,
    startedAt: 1,
    heartbeatAt: Date.now(),
    ...over,
  };
}

/** A host stub: records the tools, and answers `session.get` for the directory/title. */
async function register(options: { directory?: string; title?: string } = {}) {
  const tools = new Map<string, { name: string; execute: (input: unknown, context: unknown) => unknown }>();
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; execute: (input: unknown, context: unknown) => unknown }) => {
            tools.set(tool.name, tool);
          },
        });
        return { dispose: async () => undefined };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        title: options.title ?? "AVL rotations",
        location: { directory: options.directory ?? "/projects/demo" },
      }),
    },
  };

  const registration = await registerTools(ctx, {
    root,
    pluginEndpoint: "http://127.0.0.1:47812",
  });

  /** Run one tool the way the host does: call it, await it, read the text. */
  const run = async (name: string, input: unknown = {}, sessionID = "ses_1") => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} was not registered`);
    // The host asserts a thenable; keep that assertion here so a regression fails loudly.
    const pending = tool.execute(input, { sessionID }) as Promise<unknown>;
    if (typeof (pending as { then?: unknown })?.then !== "function") {
      throw new Error(`tool ${name} did not return a thenable`);
    }
    const result = (await pending) as { content?: Array<{ type: string; text: string }> };
    return (result.content ?? []).map((item) => item.text).join("\n");
  };

  return { run, registration, names: [...tools.keys()] };
}

describe("registration", () => {
  it("offers the three tools the agent needs", async () => {
    const { names } = await register();
    expect(names.sort()).toEqual([
      "mystudio_apps",
      "mystudio_subscribe",
      "mystudio_unsubscribe",
    ]);
  });
});

describe("mystudio_apps", () => {
  it("says nothing is running when nothing is", async () => {
    const { run } = await register();
    expect(await run("mystudio_apps")).toContain("No MyStudio app is running");
  });

  it("lists the project, endpoint and subscriber count of each app", async () => {
    await publishPresence(app({ appId: "app_a", projectName: "deck-a" }), root);
    await publishPresence(app({ appId: "app_b", projectName: "deck-b", projectDir: "/p/b" }), root);

    const text = await (await register()).run("mystudio_apps");

    expect(text).toContain("app_a");
    expect(text).toContain("deck-a");
    expect(text).toContain("/p/b");
    expect(text).toContain("conversations subscribed: 0");
  });
});

describe("mystudio_subscribe", () => {
  it("subscribes the calling session to the only app", async () => {
    await publishPresence(app(), root);
    const { run } = await register();

    const text = await run("mystudio_subscribe");

    expect(text).toContain("Subscribed");
    const [record] = await listSubscriptions("app_1", root);
    expect(record).toMatchObject({
      sessionID: "ses_1",
      pluginEndpoint: "http://127.0.0.1:47812",
      sessionTitle: "AVL rotations",
    });
  });

  it("asks which app when several are running, and subscribes nothing", async () => {
    /*
     * The failure this prevents: subscribing to the wrong window is invisible — the
     * annotations simply never arrive where the user is looking.
     */
    await publishPresence(app({ appId: "app_a" }), root);
    await publishPresence(app({ appId: "app_b" }), root);
    const { run } = await register();

    const text = await run("mystudio_subscribe");

    expect(text).toContain("ambiguous");
    expect(text).toContain("app_a");
    expect(text).toContain("app_b");
    expect(await subscriptionsOfSession("ses_1", root)).toEqual([]);
  });

  it("uses an explicit appId when the agent has already asked the user", async () => {
    await publishPresence(app({ appId: "app_a" }), root);
    await publishPresence(app({ appId: "app_b", projectDir: "/p/b" }), root);
    const { run } = await register();

    await run("mystudio_subscribe", { appId: "app_b" });

    expect((await subscriptionsOfSession("ses_1", root)).map((entry) => entry.appId)).toEqual([
      "app_b",
    ]);
  });

  it("disambiguates by the session's own project", async () => {
    await publishPresence(app({ appId: "app_a", projectDir: "/projects/a" }), root);
    await publishPresence(app({ appId: "app_b", projectDir: "/projects/b" }), root);
    const { run } = await register({ directory: "/projects/b" });

    await run("mystudio_subscribe");

    expect((await subscriptionsOfSession("ses_1", root)).map((entry) => entry.appId)).toEqual([
      "app_b",
    ]);
  });

  it("lets two sessions subscribe to the same app", async () => {
    await publishPresence(app(), root);
    const { run } = await register();
    await run("mystudio_subscribe", {}, "ses_1");
    await run("mystudio_subscribe", {}, "ses_2");
    expect((await listSubscriptions("app_1", root)).map((entry) => entry.sessionID)).toEqual([
      "ses_1",
      "ses_2",
    ]);
  });
});

describe("mystudio_unsubscribe", () => {
  it("removes this session's subscription", async () => {
    await publishPresence(app(), root);
    const { run } = await register();
    await run("mystudio_subscribe");

    const text = await run("mystudio_unsubscribe");

    expect(text).toContain("Removed 1 subscription");
    expect(await subscriptionsOfSession("ses_1", root)).toEqual([]);
  });

  it("says plainly when there was nothing to remove", async () => {
    const { run } = await register();
    expect(await run("mystudio_unsubscribe")).toContain("not subscribed");
  });
});
