import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  searchContainedFiles,
  type SearchError
} from "../../src/kernel/fs-search.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-search-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("core.search (contained filesystem search)", () => {
  it("lists files whose path matches a substring, recursively", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.txt"), "x", "utf8");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "beta.md"), "y", "utf8");
    await writeFile(join(root, "sub", "c.txt"), "z", "utf8");

    const result = await searchContainedFiles(root, "beta");
    expect(result.matches).toEqual(["sub/beta.md"]);

    const txt = await searchContainedFiles(root, ".txt");
    expect([...txt.matches].sort()).toEqual(["a.txt", "sub/c.txt"]);
  });

  it("returns an empty list when nothing matches", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.txt"), "x", "utf8");

    const result = await searchContainedFiles(root, "does-not-exist-zzz");
    expect(result.matches).toEqual([]);
  });

  it("rejects when no filesystem root is configured (default-deny)", async () => {
    await expect(searchContainedFiles(undefined, "x")).rejects.toMatchObject({
      code: "no_root"
    } satisfies Partial<SearchError>);
  });

  it("rejects an empty pattern", async () => {
    const root = await makeTempDir();
    await expect(searchContainedFiles(root, "")).rejects.toMatchObject({
      code: "invalid_pattern"
    } satisfies Partial<SearchError>);
  });

  it("bounds results to maxResults", async () => {
    const root = await makeTempDir();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `file-${i}.txt`), "x", "utf8");
    }

    const result = await searchContainedFiles(root, ".txt", 2);
    expect(result.matches.length).toBeLessThanOrEqual(2);
    // Default bound is a positive explicit limit.
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBeGreaterThan(0);
  });

  it("skips a symlink that escapes the root", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    } catch {
      return; // symlinks unsupported here (e.g. Windows without Developer Mode)
    }

    const result = await searchContainedFiles(root, "leak");
    expect(result.matches).toEqual([]);
  });
});
