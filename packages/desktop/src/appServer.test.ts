import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnnotationBundle, HostConfig } from "@mystudio/protocol";
import { BRIDGE_ROUTES } from "@mystudio/protocol";
import { MockSink as NodeMockSink } from "@mystudio/protocol/node";
import { createAppServer, createFrameWriter, startAppServer } from "./appServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mystudio-desktop-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function config(): HostConfig {
  return {
    schemaVersion: 1,
    projectId: "demo",
    projectName: "Demo",
    projectDir: "/projects/demo",
    inboxEndpoint: "http://127.0.0.1:47812",
    previewOrigin: "http://127.0.0.1:3002",
  };
}

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
        frame: {
          compositionPath: "index.html",
          time: 1.5,
          compositionWidth: 1920,
          compositionHeight: 1080,
        },
        note: "",
        createdAt: 1,
      },
    ],
    createdAt: 1,
  };
}

describe("createFrameWriter", () => {
  it("writes the decoded png to <annotationId>.png", async () => {
    const dir = await tempDir();
    const write = createFrameWriter(dir);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const path = await write({ schemaVersion: 1, annotationId: "frame_abc", pngBase64: png.toString("base64") });
    expect(path).toBe(join(dir, "frame_abc.png"));
    expect(await readFile(path)).toEqual(png);
  });

  it("sanitises the id so a crafted annotationId cannot escape the directory", async () => {
    const dir = await tempDir();
    const write = createFrameWriter(dir);
    const path = await write({
      schemaVersion: 1,
      annotationId: "../../etc/passwd",
      pngBase64: "AAAA",
    });
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain("..");
    expect(path).not.toContain("/etc/");
  });
});

describe("bridge endpoints", () => {
  it("serves the host config", async () => {
    const app = createAppServer({
      studioDir: await tempDir(),
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: await tempDir(),
    });
    const response = await app.request(BRIDGE_ROUTES.config);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ projectId: "demo", projectDir: "/projects/demo" });
  });

  it("rejects a malformed frame request instead of writing garbage", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.frame, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(response.status).toBe(400);
  });

  it("answers with a usable path when a frame is saved", async () => {
    /*
     * The discriminated `SaveFrameResponse` means `path` exists exactly when saving
     * succeeded, so the frontend never has to guess whether it can use it.
     */
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const response = await app.request(BRIDGE_ROUTES.frame, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        annotationId: "ann_1",
        pngBase64: png.toString("base64"),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: join(dir, "ann_1.png") });
  });

  it("delivers through the configured sink and reports which one ran", async () => {
    const dir = await tempDir();
    const sink = new NodeMockSink();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink,
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.deliver, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, prompt: "hello", bundle: bundle() }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: { ok: true }, sink: "mock" });
    expect(sink.lastPrompt).toBe("hello");
  });

  it("says plainly that no sink is configured rather than pretending success", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.deliver, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, prompt: "hello", bundle: bundle() }),
    });
    const body = await response.json();
    expect(body).toMatchObject({ sink: null, outcome: { ok: false, code: "unreachable" } });
  });

  it("passes an explicit session pin from the request to the sink", async () => {
    const dir = await tempDir();
    const sink = new NodeMockSink();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink,
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.deliver, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        prompt: "hello",
        bundle: bundle(),
        targetSessionID: "ses_from_request",
      }),
    });
    expect(response.status).toBe(200);
    expect(sink.deliveries[0]?.targetSessionID).toBe("ses_from_request");
  });

  it("treats a blank pin as 'no pin', not as an empty session id", async () => {
    const dir = await tempDir();
    const sink = new NodeMockSink();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink,
      framesDir: dir,
    });
    await app.request(BRIDGE_ROUTES.deliver, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        prompt: "hello",
        bundle: bundle(),
        targetSessionID: "   ",
      }),
    });
    expect(sink.deliveries[0]?.targetSessionID).toBeUndefined();
  });

  it("refuses to deliver an empty annotation list", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: dir,
    });
    const empty = { ...bundle(), annotations: [] };
    const response = await app.request(BRIDGE_ROUTES.deliver, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, prompt: "hello", bundle: empty }),
    });
    expect(response.status).toBe(400);
  });
});

describe("subscribers endpoint", () => {
  it("says so when the app has no identity, instead of returning an empty list", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.subscribers);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("identity");
  });

  it("lists the conversations subscribed to this app", async () => {
    const dir = await tempDir();
    const registry = await tempDir();
    const { publishPresence, addSubscription } = await import("@mystudio/protocol/node");
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
      registry,
    );
    await addSubscription(
      {
        version: 1,
        appId: "app_1",
        projectDir: "/projects/demo",
        sessionID: "ses_1",
        sessionTitle: "AVL rotations",
        pluginEndpoint: "http://127.0.0.1:47812",
        createdAt: 5,
      },
      registry,
    );

    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      appId: "app_1",
      registryRoot: registry,
      framesDir: dir,
    });
    const response = await app.request(BRIDGE_ROUTES.subscribers);
    expect(await response.json()).toEqual({
      ok: true,
      subscribers: [{ sessionID: "ses_1", title: "AVL rotations", createdAt: 5 }],
    });
  });
});

describe("open project endpoint", () => {
  it("reports the handler's result verbatim", async () => {
    const app = createAppServer({
      studioDir: await tempDir(),
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: await tempDir(),
      onOpenProject: async () => ({ ok: true }),
    });
    const response = await app.request(BRIDGE_ROUTES.openProject, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("passes a cancellation through instead of reporting success", async () => {
    /*
     * Cancelling is not an error: the user changed their mind. Reporting it as one would
     * make the window show a failure for something they did deliberately.
     */
    const app = createAppServer({
      studioDir: await tempDir(),
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: await tempDir(),
      onOpenProject: async () => ({ ok: false, cancelled: true }),
    });
    const response = await app.request(BRIDGE_ROUTES.openProject, { method: "POST" });
    expect(await response.json()).toEqual({ ok: false, cancelled: true });
  });

  it("returns 501 when the host cannot open projects", async () => {
    // The server is constructible without an Electron dialog; that must be explicit.
    const app = createAppServer({
      studioDir: await tempDir(),
      previewOrigin: "http://127.0.0.1:3002",
      config: config(),
      sink: new NodeMockSink(),
      framesDir: await tempDir(),
    });
    const response = await app.request(BRIDGE_ROUTES.openProject, { method: "POST" });
    expect(response.status).toBe(501);
  });
});

describe("preview proxy", () => {
  it("forwards /api/* to the preview origin and returns its body", async () => {
    const dir = await tempDir();
    const seen: string[] = [];
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const response = await app.request("/api/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    expect(seen[0]).toBe("http://127.0.0.1:9999/api/projects");
  });

  it("preserves the query string so thumbnail seek times survive the hop", async () => {
    const dir = await tempDir();
    const seen: string[] = [];
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response("png", { status: 200 });
      },
    });
    await app.request("/api/projects/demo/thumbnail/index.html?t=12.5&format=png");
    expect(seen[0]).toContain("t=12.5");
    expect(seen[0]).toContain("format=png");
  });

  it("reports a clear 502 when the preview server is down", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
      fetchImpl: async () => {
        throw new TypeError("ECONNREFUSED");
      },
    });
    const response = await app.request("/api/projects");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Preview service unreachable");
  });

  it("does not forward the incoming Host header, which the preview server guards", async () => {
    const dir = await tempDir();
    let forwardedHost: string | null = "unset";
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        forwardedHost = headers.get("host");
        return new Response("ok");
      },
    });
    await app.request("/api/projects", { headers: { host: "evil.example.com" } });
    expect(forwardedHost).toBeNull();
  });
});

describe("static serving", () => {
  it("serves index.html at the root", async () => {
    const dir = await tempDir();
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<h1>studio</h1>", "utf8");
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>studio</h1>");
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("falls back to index.html for client-side routes", async () => {
    const dir = await tempDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "index.html"), "<h1>studio</h1>", "utf8");
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    const response = await app.request("/some/spa/route");
    expect(await response.text()).toBe("<h1>studio</h1>");
  });

  it("404s a missing asset rather than answering with the SPA shell", async () => {
    const dir = await tempDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "index.html"), "<h1>studio</h1>", "utf8");
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    // Missing path with an extension: returning HTML would only make debugging harder.
    const response = await app.request("/assets/missing.js");
    expect(response.status).toBe(404);
  });

  it("blocks directory traversal", async () => {
    const dir = await tempDir();
    const app = createAppServer({
      studioDir: dir,
      previewOrigin: "http://127.0.0.1:9999",
      config: config(),
      sink: null,
      framesDir: dir,
    });
    const response = await app.request("/../../etc/passwd");
    expect([403, 404]).toContain(response.status);
  });
});

describe("startAppServer", () => {
  it("binds loopback and reports a usable url", async () => {
    const dir = await tempDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "index.html"), "<h1>studio</h1>", "utf8");
    const server = await startAppServer(
      {
        studioDir: dir,
        previewOrigin: "http://127.0.0.1:9999",
        config: config(),
        sink: null,
        framesDir: dir,
      },
      4517,
    );
    cleanups.push(() => server.close());
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${server.url}${BRIDGE_ROUTES.config}`);
    expect(response.status).toBe(200);
  });
});

describe("sink exports", () => {
  it("exposes the node sinks through the node entry, and keeps the root entry DOM-free", async () => {
    // The root entry is imported by the frontend and must stay free of Node deps;
    // sink implementations live only in the node entry.
    const root = await import("@mystudio/protocol");
    expect("resolveSink" in root).toBe(false);

    const node = await import("@mystudio/protocol/node");
    expect(typeof node.resolveSink).toBe("function");
    expect(typeof node.HttpSink).toBe("function");
    expect(typeof node.FileOutboxSink).toBe("function");
    expect(typeof node.MockSink).toBe("function");
  });
});
