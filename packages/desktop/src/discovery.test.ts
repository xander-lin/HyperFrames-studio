import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProjects } from "./discovery.js";

/**
 * Directory discovery.
 *
 * The user's report was concrete: "we should be able to open a folder, and it should
 * recognise the projects inside — if the folder itself is not a project, its
 * subdirectories probably are". Both shapes are tested here because the difference
 * between them is exactly what made the app open the wrong thing.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mystudio-discovery-"));
});

async function makeProject(dir: string, options: { name?: string; entry?: boolean; marker?: "hyperframes" | "package" | "none" } = {}) {
  await mkdir(dir, { recursive: true });
  const { name = "Untitled", entry = true, marker = "hyperframes" } = options;
  if (entry) await writeFile(join(dir, "index.html"), "<html></html>", "utf8");
  if (marker === "hyperframes") {
    await writeFile(join(dir, "hyperframes.json"), JSON.stringify({ name }), "utf8");
  } else if (marker === "package") {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  }
}

describe("discoverProjects — the picked directory is a project", () => {
  it("returns it directly instead of looking inside it", async () => {
    /*
     * The order matters. A project contains subdirectories of its own (assets,
     * compositions); scanning first would offer those as siblings of the project the
     * user actually pointed at.
     */
    await makeProject(root, { name: "My deck" });
    await mkdir(join(root, "assets"), { recursive: true });

    const result = await discoverProjects(root);
    expect(result.kind).toBe("project");
    if (result.kind !== "project") return;
    expect(result.project.name).toBe("My deck");
    expect(result.project.depth).toBe(0);
  });

  it("accepts package.json as the marker, matching upstream's rule", async () => {
    await makeProject(root, { name: "From package", marker: "package" });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("project");
  });

  it("falls back to the directory name when the manifest has none", async () => {
    await makeProject(root, { name: "" });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("project");
    if (result.kind !== "project") return;
    expect(result.project.name).toBe(root.split("/").pop());
  });
});

describe("discoverProjects — the picked directory holds projects", () => {
  it("lists each subdirectory that is a project", async () => {
    await makeProject(join(root, "deck-b"), { name: "Beta" });
    await makeProject(join(root, "deck-a"), { name: "Alpha" });

    const result = await discoverProjects(root);
    expect(result.kind).toBe("collection");
    if (result.kind !== "collection") return;
    expect(result.projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);
    expect(result.projects.every((project) => project.depth === 1)).toBe(true);
  });

  it("returns them in a stable order, because a list that reshuffles is unusable", async () => {
    for (const name of ["zeta", "alpha", "mike"]) {
      await makeProject(join(root, name), { name });
    }
    const first = await discoverProjects(root);
    const second = await discoverProjects(root);
    if (first.kind !== "collection" || second.kind !== "collection") throw new Error("expected collections");
    expect(first.projects.map((p) => p.name)).toEqual(second.projects.map((p) => p.name));
  });

  it("ignores subdirectories that are not projects", async () => {
    await makeProject(join(root, "real"), { name: "Real" });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "todo.txt"), "x", "utf8");

    const result = await discoverProjects(root);
    if (result.kind !== "collection") throw new Error("expected a collection");
    expect(result.projects).toHaveLength(1);
  });

  it("ignores a directory with index.html but no marker file", async () => {
    // Upstream requires both; matching it exactly avoids "Studio opens it, we refuse".
    await makeProject(join(root, "half"), { entry: true, marker: "none" });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("empty");
  });

  it("ignores a directory with a marker but no index.html", async () => {
    await makeProject(join(root, "half"), { entry: false, marker: "hyperframes" });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("empty");
  });

  it("skips hidden directories, which are never projects the user meant", async () => {
    await makeProject(join(root, ".cache"), { name: "Hidden" });
    await makeProject(join(root, "visible"), { name: "Visible" });
    const result = await discoverProjects(root);
    if (result.kind !== "collection") throw new Error("expected a collection");
    expect(result.projects.map((p) => p.name)).toEqual(["Visible"]);
  });
});

describe("discoverProjects — nothing found", () => {
  it("reports empty with the number of folders it looked at", async () => {
    // The number is what lets the UI say "looked in 12 folders, found no projects"
    // instead of a bare "nothing here", which reads like a bug.
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("empty");
    if (result.kind !== "empty") return;
    expect(result.scanned).toBe(2);
  });

  it("reports not-a-directory for a path that does not exist", async () => {
    const result = await discoverProjects(join(root, "nope"));
    expect(result.kind).toBe("not-a-directory");
  });

  it("reports not-a-directory for a file", async () => {
    await writeFile(join(root, "file.txt"), "x", "utf8");
    const result = await discoverProjects(join(root, "file.txt"));
    expect(result.kind).toBe("not-a-directory");
  });
});

describe("discoverProjects — cleanup", () => {
  it("does not need the temp tree after the case", async () => {
    // The suite creates a real tree per case; removing it keeps /tmp from filling up
    // during a long run.
    await rm(root, { recursive: true, force: true });
    const result = await discoverProjects(root);
    expect(result.kind).toBe("not-a-directory");
  });
});
