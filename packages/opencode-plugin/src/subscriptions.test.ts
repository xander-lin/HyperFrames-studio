import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSubscription,
  listSubscriptions,
  publishPresence,
  subscriptionsOfSession,
  type AppPresence,
} from "@mystudio/protocol/node";
import { chooseApp, subscribeSession, unsubscribeSession } from "./subscriptions.js";

/**
 * The rules behind `mystudio_subscribe`.
 *
 * The one that matters: when two apps are running, the tool **refuses** instead of picking
 * one. A wrong subscription is invisible — annotations simply go to the other window — so
 * every ambiguous case has to be surfaced as a question.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mystudio-subscribe-"));
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

async function live(...apps: AppPresence[]) {
  for (const presence of apps) await publishPresence(presence, root);
}

describe("chooseApp", () => {
  it("uses the only running app without ceremony", () => {
    const choice = chooseApp([app()], {});
    expect(choice.ok && choice.app.appId).toBe("app_1");
  });

  it("refuses when nothing is running, and says what to do", () => {
    const choice = chooseApp([], {});
    expect(choice.ok).toBe(false);
    if (choice.ok) throw new Error("expected a refusal");
    expect(choice.reason).toContain("No MyStudio app is running");
  });

  it("refuses when two apps run and names both", () => {
    /*
     * "We may have started several apps" — this is the case the refusal exists for.
     */
    const choice = chooseApp([app({ appId: "app_a" }), app({ appId: "app_b" })], {});
    expect(choice.ok).toBe(false);
    if (choice.ok) throw new Error("expected a refusal");
    expect((choice.candidates ?? []).map((candidate) => candidate.appId)).toEqual([
      "app_a",
      "app_b",
    ]);
  });

  it("uses appId when given", () => {
    const choice = chooseApp([app({ appId: "app_a" }), app({ appId: "app_b" })], { appId: "app_b" });
    expect(choice.ok && choice.app.appId).toBe("app_b");
  });

  it("reports an unknown appId instead of falling back to a guess", () => {
    const choice = chooseApp([app({ appId: "app_a" })], { appId: "app_missing" });
    expect(choice.ok).toBe(false);
    if (choice.ok) throw new Error("expected a refusal");
    expect(choice.reason).toContain("app_missing");
  });

  it("disambiguates by the session's project when only one app matches", () => {
    const choice = chooseApp(
      [app({ appId: "app_a", projectDir: "/projects/a" }), app({ appId: "app_b", projectDir: "/projects/b" })],
      { sessionDirectory: "/projects/b" },
    );
    expect(choice.ok && choice.app.appId).toBe("app_b");
  });

  it("still refuses when two apps share the session's directory", () => {
    // Two windows on the same project are indistinguishable by directory alone.
    const choice = chooseApp(
      [app({ appId: "app_a" }), app({ appId: "app_b" })],
      { sessionDirectory: "/projects/demo" },
    );
    expect(choice.ok).toBe(false);
  });
});

describe("subscribeSession", () => {
  it("writes a subscription naming this plugin's endpoint", async () => {
    await live(app());
    const result = await subscribeSession({
      root,
      sessionID: "ses_1",
      sessionTitle: "AVL rotations",
      pluginEndpoint: "http://127.0.0.1:47812",
    });
    expect(result.ok).toBe(true);

    const [record] = await listSubscriptions("app_1", root);
    expect(record).toMatchObject({
      appId: "app_1",
      sessionID: "ses_1",
      sessionTitle: "AVL rotations",
      pluginEndpoint: "http://127.0.0.1:47812",
      projectDir: "/projects/demo",
    });
  });

  it("lets several sessions subscribe to the same app", async () => {
    await live(app());
    for (const sessionID of ["ses_1", "ses_2"]) {
      await subscribeSession({ root, sessionID, pluginEndpoint: "http://127.0.0.1:47812" });
    }
    expect((await listSubscriptions("app_1", root)).map((entry) => entry.sessionID)).toEqual([
      "ses_1",
      "ses_2",
    ]);
  });

  it("writes nothing when the choice is ambiguous", async () => {
    // No half-subscription: the caller gets the candidates and asks the user.
    await live(app({ appId: "app_a" }), app({ appId: "app_b" }));
    const result = await subscribeSession({
      root,
      sessionID: "ses_1",
      pluginEndpoint: "http://127.0.0.1:47812",
    });
    expect(result.ok).toBe(false);
    expect(await subscriptionsOfSession("ses_1", root)).toEqual([]);
  });
});

describe("unsubscribeSession", () => {
  it("removes every subscription this session holds", async () => {
    await live(app({ appId: "app_a" }), app({ appId: "app_b" }));
    await addSubscription(
      { version: 1, appId: "app_a", projectDir: "/p", sessionID: "ses_1", pluginEndpoint: "http://x", createdAt: 1 },
      root,
    );
    await addSubscription(
      { version: 1, appId: "app_b", projectDir: "/p", sessionID: "ses_1", pluginEndpoint: "http://x", createdAt: 2 },
      root,
    );

    expect(await unsubscribeSession({ root, sessionID: "ses_1" })).toBe(2);
    expect(await subscriptionsOfSession("ses_1", root)).toEqual([]);
  });

  it("removes only the named app", async () => {
    await live(app({ appId: "app_a" }), app({ appId: "app_b" }));
    for (const appId of ["app_a", "app_b"]) {
      await addSubscription(
        { version: 1, appId, projectDir: "/p", sessionID: "ses_1", pluginEndpoint: "http://x", createdAt: 1 },
        root,
      );
    }

    expect(await unsubscribeSession({ root, sessionID: "ses_1", appId: "app_b" })).toBe(1);
    expect((await subscriptionsOfSession("ses_1", root)).map((entry) => entry.appId)).toEqual([
      "app_a",
    ]);
  });

  it("reports zero when the session was never subscribed", async () => {
    expect(await unsubscribeSession({ root, sessionID: "ses_none" })).toBe(0);
  });
});
