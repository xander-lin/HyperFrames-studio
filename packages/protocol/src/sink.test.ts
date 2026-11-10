import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation, AnnotationBundle } from "./annotation.js";
import { validateBundle } from "./sink.js";
import { FallbackSink, resolveSink } from "./node/resolveSink.js";
import { FileOutboxSink, readOutbox } from "./node/fileOutboxSink.js";
import { HttpSink } from "./node/httpSink.js";
import { MockSink } from "./node/mockSink.js";

function annotation(id: string): Annotation {
  return {
    id,
    shape: { kind: "region", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    frame: {
      compositionPath: "index.html",
      time: 1.5,
      compositionWidth: 1920,
      compositionHeight: 1080,
    },
    note: "",
    createdAt: 1,
  };
}

function bundle(over: Partial<AnnotationBundle> = {}): AnnotationBundle {
  return {
    schemaVersion: 1,
    projectDir: "/projects/demo",
    projectId: "demo",
    summary: "",
    annotations: [annotation("a1")],
    createdAt: 1,
    ...over,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanups.splice(0)) await step();
  vi.unstubAllGlobals();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mystudio-outbox-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("validateBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(validateBundle(bundle())).toBeNull();
  });

  it("rejects the wrong protocol version", () => {
    const bad = { ...bundle(), schemaVersion: 2 as unknown as 1 };
    expect(validateBundle(bad)).toContain("protocol version");
  });

  it("rejects an empty payload, with neither blocks nor handwriting", () => {
    expect(validateBundle(bundle({ annotations: [] }))).toContain("No annotations");
  });

  it("accepts a payload that is only handwriting", () => {
    /*
     * Ink has no block reference, so a frame the user only wrote on produces no
     * annotation at all — yet the picture *is* the message. Rejecting it would tell the
     * user "nothing to send" while their handwriting is on screen.
     */
    const inkOnly = bundle({
      annotations: [],
      ink: [{ compositionPath: "index.html", time: 2, imagePath: "/frames/ink.png" }],
    });
    expect(validateBundle(inkOnly)).toBeNull();
  });

  it("rejects a handwriting capture with no image", () => {
    const broken = bundle({
      annotations: [],
      ink: [{ compositionPath: "index.html", time: 2, imagePath: "  " }],
    });
    expect(validateBundle(broken)).toContain("no image path");
  });

  it("rejects a handwriting capture with a nonsense timecode", () => {
    const broken = bundle({
      annotations: [],
      ink: [{ compositionPath: "index.html", time: Number.NaN, imagePath: "/frames/ink.png" }],
    });
    expect(validateBundle(broken)).toContain("invalid timecode");
  });

  it("rejects a missing composition path", () => {
    const broken: Annotation = {
      ...annotation("a1"),
      frame: { compositionPath: "", time: 0, compositionWidth: 1, compositionHeight: 1 },
    };
    expect(validateBundle(bundle({ annotations: [broken] }))).toContain("composition path");
  });

  it("rejects a non-finite time", () => {
    const broken: Annotation = {
      ...annotation("a1"),
      frame: {
        compositionPath: "index.html",
        time: Number.NaN,
        compositionWidth: 1,
        compositionHeight: 1,
      },
    };
    expect(validateBundle(bundle({ annotations: [broken] }))).toContain("invalid timecode");
  });
});

describe("MockSink", () => {
  it("records deliveries so tests can assert on the exact prompt", async () => {
    const sink = new MockSink();
    const result = await sink.deliver(bundle(), "hello");
    expect(result.ok).toBe(true);
    expect(sink.lastPrompt).toBe("hello");
  });

  it("reports the injected failure verbatim", async () => {
    const sink = new MockSink();
    sink.failWith = { ok: false, code: "unreachable", message: "down" };
    const result = await sink.deliver(bundle(), "x");
    expect(result).toEqual({ ok: false, code: "unreachable", message: "down" });
    expect(sink.deliveries).toHaveLength(0);
  });

  it("refuses an invalid bundle before recording it", async () => {
    const sink = new MockSink();
    const result = await sink.deliver(bundle({ annotations: [] }), "x");
    expect(result.ok).toBe(false);
    expect(sink.deliveries).toHaveLength(0);
  });
});

describe("HttpSink", () => {
  it("posts the prompt and bundle to /annotations", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    const sink = new HttpSink({ endpoint: "http://127.0.0.1:47812/", fetchImpl });
    const result = await sink.deliver(bundle(), "the prompt");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("http://127.0.0.1:47812/annotations");
    expect(calls[0]?.body).toMatchObject({ schemaVersion: 1, prompt: "the prompt" });
  });

  it("maps an unreachable endpoint to a user-facing message", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const sink = new HttpSink({ endpoint: "http://127.0.0.1:1", fetchImpl });
    const result = await sink.deliver(bundle(), "x");
    expect(result).toEqual({ ok: false, code: "unreachable", message: "Cannot reach the inbox: fetch failed" });
  });

  it("distinguishes an auth rejection from a generic rejection", async () => {
    const unauthorized = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async () => new Response("no", { status: 401 }),
    });
    expect((await unauthorized.deliver(bundle(), "x")).ok).toBe(false);
    expect(await unauthorized.deliver(bundle(), "x")).toMatchObject({ code: "unauthorized" });

    const rejected = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async () => new Response("bad bundle", { status: 422 }),
    });
    expect(await rejected.deliver(bundle(), "x")).toMatchObject({ code: "rejected" });
  });

  it("turns a hung request into a timeout outcome rather than hanging", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const sink = new HttpSink({ endpoint: "http://x", timeoutMs: 10, fetchImpl });
    const result = await sink.deliver(bundle(), "x");
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("refuses to send an invalid bundle at all", async () => {
    let called = false;
    const sink = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    const result = await sink.deliver(bundle({ annotations: [] }), "x");
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("carries an explicit session pin in the request body", async () => {
    /*
     * Pinning is the only way to correct a wrong auto-selection, so it has to survive the
     * hop from the app to the plugin — otherwise the field exists and nothing can use it.
     */
    let sent: Record<string, unknown> = {};
    const sink = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async (_input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      },
    });
    await sink.deliver(bundle(), "p", { targetSessionID: "ses_pinned" });
    expect(sent["targetSessionID"]).toBe("ses_pinned");
  });

  it("omits the pin entirely when the caller did not name one", async () => {
    // An empty string would look like "deliver to session ''" at the other end.
    let sent: Record<string, unknown> = {};
    const sink = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async (_input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      },
    });
    await sink.deliver(bundle(), "p", { targetSessionID: "   " });
    expect("targetSessionID" in sent).toBe(false);
  });

  it("reports the session the plugin chose", async () => {
    /*
     * The plugin decides where a prompt goes. Without this coming back, the interface can
     * only say "Sent", and a prompt that landed in the wrong conversation is invisible.
     */
    const sink = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            sessionID: "ses_here",
            title: "AVL rotations",
            created: false,
            reason: "last-viewed",
          }),
          { status: 200 },
        ),
    });
    const result = await sink.deliver(bundle(), "p");
    expect(result).toMatchObject({
      ok: true,
      target: { sessionID: "ses_here", title: "AVL rotations", created: false, reason: "last-viewed" },
    });
  });

  it("still succeeds when the answer does not describe a session", async () => {
    // A malformed answer must not turn a real delivery into a failure.
    const sink = new HttpSink({
      endpoint: "http://x",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const result = await sink.deliver(bundle(), "p");
    expect(result.ok).toBe(true);
    expect(result.ok && result.target).toBeUndefined();
  });
});

describe("FileOutboxSink", () => {
  it("writes one json file per delivery and leaves no temp file behind", async () => {
    const dir = await tempDir();
    const sink = new FileOutboxSink({ dir });
    const result = await sink.deliver(bundle(), "prompt text");
    expect(result.ok).toBe(true);
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.json$/);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("stores the session pin with the record, so replay lands where the user pointed", async () => {
    /*
     * An annotation queued while OpenCode was down is delivered later. If the pin did not
     * travel with the file, replay would auto-select and the user's explicit choice would
     * be silently discarded.
     */
    const dir = await tempDir();
    const sink = new FileOutboxSink({ dir });
    await sink.deliver(bundle(), "p", { targetSessionID: "ses_pinned" });
    const payloads = await readOutbox(dir);
    expect(payloads[0]?.targetSessionID).toBe("ses_pinned");
  });

  it("round-trips through readOutbox in chronological order", async () => {
    const dir = await tempDir();
    const sink = new FileOutboxSink({ dir });
    await sink.deliver(bundle(), "first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sink.deliver(bundle(), "second");
    const payloads = await readOutbox(dir);
    expect(payloads.map((p) => p.prompt)).toEqual(["first", "second"]);
    expect(payloads[0]?.bundle.projectDir).toBe("/projects/demo");
  });

  it("returns an empty list for a directory that does not exist yet", async () => {
    expect(await readOutbox("/definitely/not/here")).toEqual([]);
  });

  it("skips a corrupt file instead of blocking the whole outbox", async () => {
    const dir = await tempDir();
    const sink = new FileOutboxSink({ dir });
    await sink.deliver(bundle(), "good");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "0000-broken.json"), "{not json", "utf8");
    const payloads = await readOutbox(dir);
    expect(payloads.map((p) => p.prompt)).toEqual(["good"]);
  });
});

describe("FallbackSink", () => {
  it("uses the primary when it succeeds and never touches the fallback", async () => {
    const primary = new MockSink();
    const fallback = new MockSink();
    const sink = new FallbackSink(primary, fallback);
    const result = await sink.deliver(bundle(), "x");
    expect(result.ok).toBe(true);
    expect(fallback.deliveries).toHaveLength(0);
  });

  it("falls back to disk when the plugin inbox is unreachable", async () => {
    const primary = new MockSink();
    primary.failWith = { ok: false, code: "unreachable", message: "refused" };
    const fallback = new MockSink();
    const sink = new FallbackSink(primary, fallback);
    const result = await sink.deliver(bundle(), "x");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain("queued in the outbox");
    expect(fallback.deliveries).toHaveLength(1);
  });

  it("does not fall back on a content rejection, because another channel cannot fix it", async () => {
    const primary = new MockSink();
    primary.failWith = { ok: false, code: "rejected", message: "bad" };
    const fallback = new MockSink();
    const sink = new FallbackSink(primary, fallback);
    const result = await sink.deliver(bundle(), "x");
    expect(result.ok).toBe(false);
    expect(fallback.deliveries).toHaveLength(0);
  });

  it("reports both failures when neither channel works", async () => {
    const primary = new MockSink();
    primary.failWith = { ok: false, code: "unreachable", message: "refused" };
    const fallback = new MockSink();
    fallback.failWith = { ok: false, code: "write-failed", message: "disk full" };
    const sink = new FallbackSink(primary, fallback);
    const result = await sink.deliver(bundle(), "x");
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
    if (!result.ok) expect(result.message).toContain("disk full");
  });
});

describe("resolveSink", () => {
  it("prefers an explicitly forced sink", () => {
    const forced = new MockSink();
    expect(resolveSink({ force: forced })).toBe(forced);
  });

  it("combines http and outbox when both are configured", () => {
    const sink = resolveSink({ inboxEndpoint: "http://127.0.0.1:1", outboxDir: "/tmp/x" });
    expect(sink?.name).toBe("http+file-outbox");
  });

  it("falls back to whichever single channel is configured", () => {
    expect(resolveSink({ outboxDir: "/tmp/x" })?.name).toBe("file-outbox");
    expect(resolveSink({ inboxEndpoint: "http://127.0.0.1:1" })?.name).toBe("http");
  });

  it("returns null when nothing is configured, so the UI can say so plainly", () => {
    expect(resolveSink({})).toBeNull();
  });
});
