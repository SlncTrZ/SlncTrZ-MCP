import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstructionContextResolver } from "../../src/context/instruction-context.js";

const cleanup: string[] = [];

async function tempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "slnctrz-context-"));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project instruction context", () => {
  it("discovers explicit sources with deterministic user/workspace/directory precedence", async () => {
    const root = await tempWorkspace();
    const userFile = join(root, "user.md");
    await mkdir(join(root, "src", "feature"), { recursive: true });
    await writeFile(userFile, "user context", "utf8");
    await writeFile(join(root, "WORKSPACE.md"), "workspace context", "utf8");
    await writeFile(join(root, "INSTRUCTIONS.md"), "root directory context", "utf8");
    await writeFile(join(root, "src", "INSTRUCTIONS.md"), "source context", "utf8");
    await writeFile(join(root, "src", "feature", "INSTRUCTIONS.md"), "feature context", "utf8");

    const resolver = createInstructionContextResolver({
      workspaceRoot: root,
      userFiles: [userFile],
      workspaceFiles: ["WORKSPACE.md"],
      directoryFileNames: ["INSTRUCTIONS.md"]
    });
    const result = await resolver.resolve("src/feature");

    expect(result.sources.map((source) => [source.scope, source.path, source.status])).toEqual([
      ["user", "user/1-user.md", "loaded"],
      ["workspace", "WORKSPACE.md", "loaded"],
      ["directory", "src/feature/INSTRUCTIONS.md", "loaded"],
      ["directory", "src/INSTRUCTIONS.md", "loaded"],
      ["directory", "INSTRUCTIONS.md", "loaded"]
    ]);
    expect(result.sources.map((source) => source.content)).toEqual([
      "user context",
      "workspace context",
      "feature context",
      "source context",
      "root directory context"
    ]);
    expect(result.sources.every((source) => source.sha256?.length === 64)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(userFile);

    const priorHash = result.sources[1]?.sha256;
    await writeFile(join(root, "WORKSPACE.md"), "changed workspace context", "utf8");
    const changed = await resolver.resolve("src/feature");
    expect(changed.sources[1]?.sha256).not.toBe(priorHash);
  });

  it("references whole files deterministically when the context budget is exhausted", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "A.md"), "1234", "utf8");
    await writeFile(join(root, "B.md"), "5678", "utf8");
    const resolver = createInstructionContextResolver({
      workspaceRoot: root,
      userFiles: [],
      workspaceFiles: ["A.md", "B.md"],
      directoryFileNames: [],
      maxContextBytes: 4
    });

    const result = await resolver.resolve();
    expect(result.loadedBytes).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.sources.map((source) => source.status)).toEqual(["loaded", "referenced"]);
    expect(result.sources[1]?.content).toBeUndefined();

    const index = await resolver.resolve(".", { includeContent: false });
    expect(index.truncated).toBe(false);
    expect(index.sources.map((source) => source.status)).toEqual(["referenced", "referenced"]);
  });

  it("fails closed for missing, malformed, and oversized sources", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, "large.md"), "12345", "utf8");

    const resolver = createInstructionContextResolver({
      workspaceRoot: root,
      userFiles: [],
      workspaceFiles: ["missing.md", "invalid.md", "large.md"],
      directoryFileNames: [],
      maxFileBytes: 4
    });
    const result = await resolver.resolve();

    expect(result.sources.map((source) => [source.path, source.status])).toEqual([
      ["missing.md", "missing"],
      ["invalid.md", "invalid_encoding"],
      ["large.md", "oversized"]
    ]);
  });

  it.skipIf(process.platform === "win32")("fails closed for a symlink-escaped source", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(outside, "outside.md"), "must not load", "utf8");
    await symlink(join(outside, "outside.md"), join(root, "src", "INSTRUCTIONS.md"));

    const resolver = createInstructionContextResolver({
      workspaceRoot: root,
      userFiles: [],
      workspaceFiles: [],
      directoryFileNames: ["INSTRUCTIONS.md"]
    });
    const result = await resolver.resolve("src");

    expect(result.sources.map((source) => [source.path, source.status])).toEqual([
      ["src/INSTRUCTIONS.md", "denied"]
    ]);
    expect(JSON.stringify(result)).not.toContain("must not load");
  });

  it("rejects target traversal and non-directory targets", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "file.txt"), "x", "utf8");
    const resolver = createInstructionContextResolver({
      workspaceRoot: root,
      userFiles: [],
      workspaceFiles: [],
      directoryFileNames: []
    });

    await expect(resolver.resolve("../escape")).rejects.toThrow("escapes the workspace");
    await expect(resolver.resolve("file.txt")).rejects.toThrow("must be a directory");
  });
});
