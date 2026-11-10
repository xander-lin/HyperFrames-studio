import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listApps } from "@mystudio/protocol/node";
import { newAppId, publishAppPresence } from "./presence.js";

/**
 * The advertised identity.
 *
 * A single property is load-bearing: **the id in the presence record is the id the app
 * server looks subscriptions up by**. Generating it twice produced a running app that
 * advertised one identity and queried another, so `/subscribers` answered "nobody
 * subscribed" while the subscription files sat on disk (found.md F-085).
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mystudio-presence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("newAppId", () => {
  it("is distinct per launch, so two windows on one project can be told apart", () => {
    expect(newAppId()).not.toBe(newAppId());
  });
});

describe("publishAppPresence", () => {
  it("advertises exactly the id it was given", async () => {
    const root = await tempRoot();
    const appId = "app_fixed_1";

    const handle = await publishAppPresence({
      appId,
      projectDir: "/projects/demo",
      projectName: "demo",
      endpoint: "http://127.0.0.1:4317",
      root,
    });
    cleanups.push(() => handle.stop());

    expect(handle.appId).toBe(appId);
    const [app] = await listApps(root);
    expect(app?.appId).toBe(appId);
  });

  it("writes the record the plugin needs to post back", async () => {
    const root = await tempRoot();
    const handle = await publishAppPresence({
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "deck",
      endpoint: "http://127.0.0.1:4318",
      root,
    });
    cleanups.push(() => handle.stop());

    const raw = JSON.parse(
      await readFile(join(root, "apps", "app_1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "deck",
      endpoint: "http://127.0.0.1:4318",
      pid: process.pid,
    });
  });

  it("refreshes the heartbeat so the app stays listed", async () => {
    const root = await tempRoot();
    const handle = await publishAppPresence({
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "deck",
      endpoint: "http://127.0.0.1:4317",
      root,
    });
    cleanups.push(() => handle.stop());

    await handle.beat();
    expect((await listApps(root)).map((app) => app.appId)).toEqual(["app_1"]);
  });

  it("withdraws on stop, so the agent is not offered a dead app", async () => {
    const root = await tempRoot();
    const handle = await publishAppPresence({
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "deck",
      endpoint: "http://127.0.0.1:4317",
      root,
    });

    await handle.stop();
    expect(await listApps(root)).toEqual([]);
  });

  it("stopping twice is harmless", async () => {
    const root = await tempRoot();
    const handle = await publishAppPresence({
      appId: "app_1",
      projectDir: "/projects/demo",
      projectName: "deck",
      endpoint: "http://127.0.0.1:4317",
      root,
    });
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
