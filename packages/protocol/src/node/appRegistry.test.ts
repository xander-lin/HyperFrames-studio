import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSubscription,
  listApps,
  subscriptionsForApp,
  listSubscriptions,
  pruneDeadSubscriptions,
  publishPresence,
  subscriptionsOfSession,
  withdrawPresence,
} from "./appRegistry.js";
import { PRESENCE_TTL_MS, type AppPresence, type Subscription } from "../presence.js";

/**
 * The shared registry both processes meet through.
 *
 * What matters here is the **liveness rule**: a dead app must stop being offered to the
 * agent, and a dead app's subscriptions must stop being listed as delivery targets. Without
 * it, a `kill -9` leaves a phantom app that silently swallows annotations.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mystudio-registry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function presence(over: Partial<AppPresence> = {}): AppPresence {
  return {
    version: 1,
    appId: "app_1",
    projectDir: "/projects/demo",
    projectName: "demo",
    endpoint: "http://127.0.0.1:4317",
    pid: 1,
    startedAt: 100,
    heartbeatAt: Date.now(),
    ...over,
  };
}

function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    version: 1,
    appId: "app_1",
    projectDir: "/projects/demo",
    sessionID: "ses_1",
    pluginEndpoint: "http://127.0.0.1:47812",
    createdAt: 1,
    ...over,
  };
}

describe("presence", () => {
  it("lists a live app", async () => {
    const root = await tempRoot();
    await publishPresence(presence(), root);
    expect((await listApps(root)).map((app) => app.appId)).toEqual(["app_1"]);
  });

  it("drops an app whose heartbeat stopped", async () => {
    /*
     * A `kill -9` cannot clean up after itself. Without the TTL the agent would keep being
     * offered an app that can never deliver.
     */
    const root = await tempRoot();
    await publishPresence(presence({ heartbeatAt: Date.now() - PRESENCE_TTL_MS - 1000 }), root);
    expect(await listApps(root)).toEqual([]);
  });

  it("removes the stale record it found, so it is not rescanned forever", async () => {
    const root = await tempRoot();
    await publishPresence(presence({ heartbeatAt: 0 }), root);
    await listApps(root);
    expect(await readdir(join(root, "apps"))).toEqual([]);
  });

  it("stops listing an app that withdrew", async () => {
    const root = await tempRoot();
    await publishPresence(presence(), root);
    await withdrawPresence("app_1", root);
    expect(await listApps(root)).toEqual([]);
  });

  it("keeps two launches of the same project distinct", async () => {
    // "We may have started several apps" — the user must be able to pick one.
    const root = await tempRoot();
    await publishPresence(presence({ appId: "app_a" }), root);
    await publishPresence(presence({ appId: "app_b" }), root);
    expect((await listApps(root)).map((app) => app.appId)).toEqual(["app_a", "app_b"]);
  });

  it("treats an unreadable record as absent rather than failing the whole list", async () => {
    const root = await tempRoot();
    await publishPresence(presence({ appId: "app_ok" }), root);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "apps"), { recursive: true });
    await writeFile(join(root, "apps", "broken.json"), "{not json", "utf8");
    expect((await listApps(root)).map((app) => app.appId)).toEqual(["app_ok"]);
  });
});

describe("subscriptions", () => {
  it("records one session's subscription and lists it for the app", async () => {
    const root = await tempRoot();
    await addSubscription(subscription(), root);
    expect((await listSubscriptions("app_1", root)).map((entry) => entry.sessionID)).toEqual([
      "ses_1",
    ]);
  });

  it("supports several sessions on one app", async () => {
    // The whole point of the model: everyone who subscribed receives it.
    const root = await tempRoot();
    await addSubscription(subscription({ sessionID: "ses_1" }), root);
    await addSubscription(subscription({ sessionID: "ses_2" }), root);
    expect((await listSubscriptions("app_1", root)).map((entry) => entry.sessionID)).toEqual([
      "ses_1",
      "ses_2",
    ]);
  });

  it("is idempotent: subscribing twice keeps one record", async () => {
    const root = await tempRoot();
    await addSubscription(subscription(), root);
    await addSubscription(subscription(), root);
    expect(await listSubscriptions("app_1", root)).toHaveLength(1);
  });

  it("finds every app a session subscribed to", async () => {
    const root = await tempRoot();
    await publishPresence(presence({ appId: "app_1" }), root);
    await publishPresence(presence({ appId: "app_2" }), root);
    await addSubscription(subscription({ appId: "app_1", sessionID: "ses_9" }), root);
    await addSubscription(subscription({ appId: "app_2", sessionID: "ses_9" }), root);
    expect((await subscriptionsOfSession("ses_9", root)).map((entry) => entry.appId).sort()).toEqual([
      "app_1",
      "app_2",
    ]);
  });

  it("prunes subscriptions whose app is gone", async () => {
    /*
     * A conversation subscribed to a crashed app would otherwise look permanently
     * subscribed to something that cannot deliver.
     */
    const root = await tempRoot();
    await addSubscription(subscription({ appId: "app_dead", sessionID: "ses_1" }), root);
    expect(await pruneDeadSubscriptions(root)).toBe(1);
    expect(await listSubscriptions("app_dead", root)).toEqual([]);
  });

  it("leaves subscriptions of a live app alone", async () => {
    const root = await tempRoot();
    await publishPresence(presence(), root);
    await addSubscription(subscription(), root);
    expect(await pruneDeadSubscriptions(root)).toBe(0);
    expect(await listSubscriptions("app_1", root)).toHaveLength(1);
  });

  describe("subscriptionsForApp", () => {
    it("finds subscriptions made before a restart of the same project", async () => {
      /*
       * The reported failure: restart MyStudio, and the next delivery queued because nobody
       * looked subscribed. A subscription names a **project**, so it must outlive the launch
       * id that happened to exist when it was made (found.md F-098).
       */
      const root = await tempRoot();
      await addSubscription(subscription({ appId: "app_old_launch", sessionID: "ses_1" }), root);

      const found = await subscriptionsForApp(
        { appId: "app_new_launch", projectDir: "/projects/demo" },
        root,
      );
      expect(found.map((entry) => entry.sessionID)).toEqual(["ses_1"]);
    });

    it("includes this launch's own subscriptions first", async () => {
      const root = await tempRoot();
      await addSubscription(subscription({ appId: "app_old", sessionID: "ses_old", createdAt: 1 }), root);
      await addSubscription(subscription({ appId: "app_new", sessionID: "ses_new", createdAt: 2 }), root);

      const found = await subscriptionsForApp(
        { appId: "app_new", projectDir: "/projects/demo" },
        root,
      );
      // Own subscriptions come first, then inherited ones; each group in creation order.
      expect(found.map((entry) => entry.sessionID)).toEqual(["ses_old", "ses_new"]);
    });

    it("never borrows a subscription from a different project", async () => {
      // Otherwise one deck's annotations would be delivered into another deck's chat.
      const root = await tempRoot();
      await addSubscription(
        subscription({ appId: "app_other", sessionID: "ses_other", projectDir: "/projects/other" }),
        root,
      );

      const found = await subscriptionsForApp(
        { appId: "app_new", projectDir: "/projects/demo" },
        root,
      );
      expect(found).toEqual([]);
    });

    it("does not list the same session twice", async () => {
      const root = await tempRoot();
      await addSubscription(subscription({ appId: "app_old", sessionID: "ses_1" }), root);
      await addSubscription(subscription({ appId: "app_new", sessionID: "ses_1" }), root);

      const found = await subscriptionsForApp(
        { appId: "app_new", projectDir: "/projects/demo" },
        root,
      );
      expect(found).toHaveLength(1);
    });

    it("ignores a trailing separator when comparing projects", async () => {
      const root = await tempRoot();
      await addSubscription(
        subscription({ appId: "app_old", projectDir: "/projects/demo/" }),
        root,
      );
      const found = await subscriptionsForApp(
        { appId: "app_new", projectDir: "/projects/demo" },
        root,
      );
      expect(found).toHaveLength(1);
    });
  });

  it("cannot be tricked into writing outside the registry", async () => {
    // Ids arrive from another process; `../..` must not become a path.
    const root = await tempRoot();
    await addSubscription(subscription({ appId: "../../escape", sessionID: "ses_1" }), root);
    const dirs = await readdir(join(root, "subscriptions"));
    // Dots are not part of the safe alphabet, so `..` cannot survive as a path segment.
    expect(dirs).toEqual(["______escape"]);
  });
});
