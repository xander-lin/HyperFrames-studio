import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, buildFrameUrl, captureFrame } from "./frameCapture.js";

const frame = {
  compositionPath: "compositions/intro.html",
  time: 12.3456,
  compositionWidth: 1920,
  compositionHeight: 1080,
};

describe("buildFrameUrl", () => {
  it("requests the frame on this origin, so the browser does not treat it as cross-site", () => {
    // The renderer runs on the app server and preview is on another port; an absolute
    // URL is cross-origin and gets blocked.
    const url = buildFrameUrl(frame, { projectId: "demo" });
    expect(url.startsWith("/api/projects/")).toBe(true);
    expect(url).not.toContain("http://");
  });

  it("encodes the project id and composition path", () => {
    const url = buildFrameUrl({ ...frame, compositionPath: "compositions/my intro.html" }, {
      projectId: "demo project",
    });
    expect(url).toContain("demo%20project");
    expect(url).toContain("compositions%2Fmy%20intro.html");
  });

  it("carries the exact seek time with millisecond precision", () => {
    const url = buildFrameUrl(frame, { projectId: "demo" });
    expect(url).toContain("t=12.346");
  });

  it("asks for source density so the agent gets a legible frame", () => {
    const url = buildFrameUrl(frame, { projectId: "demo" });
    expect(url).toContain("output=source");
    expect(url).toContain("format=png");
  });

  it("defaults to index.html when the path is empty", () => {
    const url = buildFrameUrl({ ...frame, compositionPath: "" }, { projectId: "demo" });
    expect(url).toContain("index.html");
  });

  it("clamps a negative time to zero", () => {
    const url = buildFrameUrl({ ...frame, time: -5 }, { projectId: "demo" });
    expect(url).toContain("t=0.000");
  });
});

describe("captureFrame", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it("returns base64 png bytes on success", async () => {
    const result = await captureFrame(frame, { projectId: "demo" }, async () =>
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pngBase64).toBe(Buffer.from(png).toString("base64"));
  });

  it("names the HTTP status when the endpoint fails", async () => {
    const result = await captureFrame(frame, { projectId: "demo" }, async () =>
      new Response("nope", { status: 404 }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("404");
  });

  it("detects a JSON error body served with 200, instead of storing it as an image", async () => {
    const result = await captureFrame(frame, { projectId: "demo" }, async () =>
      new Response(JSON.stringify({ error: "no composition" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("did not return an image");
  });

  it("treats an empty body as a failure, not a zero-byte screenshot", async () => {
    const result = await captureFrame(frame, { projectId: "demo" }, async () =>
      new Response(new Uint8Array(), { headers: { "content-type": "image/png" } }),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("reports a network failure without throwing", async () => {
    const result = await captureFrame(frame, { projectId: "demo" }, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("Failed to fetch");
  });
});

describe("arrayBufferToBase64", () => {
  it("matches the canonical base64 of a byte sequence", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("handles a payload larger than the internal chunk size", () => {
    const bytes = new Uint8Array(70_000).fill(0xab);
    expect(arrayBufferToBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
