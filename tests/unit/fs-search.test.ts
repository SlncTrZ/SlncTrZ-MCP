import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_SEARCH_ENTRIES,
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
  it("returns deterministic recursive filename matches", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "z.txt"), "x", "utf8");
    await writeFile(join(root, "a.txt"), "x", "utf8");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "b.txt"), "x", "utf8");

    const result = await searchContainedFiles(root, ".txt");
    expect(result.matches).toEqual(["a.txt", "sub/b.txt", "z.txt"]);
    expect(result.truncated).toBe(false);
    expect(result.scannedEntries).toBeGreaterThan(0);
  });

  it("returns an empty deterministic result when nothing matches", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.txt"), "x", "utf8");

    await expect(searchContainedFiles(root, "missing")).resolves.toEqual({
      matches: [],
      scannedEntries: 1,
      truncated: false
    });
  });

  it("rejects missing root, empty pattern, and invalid limits", async () => {
    await expect(searchContainedFiles(undefined, "x")).rejects.toMatchObject({
      code: "no_root"
    } satisfies Partial<SearchError>);

    const root = await makeTempDir();
    await expect(searchContainedFiles(root, "")).rejects.toMatchObject({
      code: "invalid_pattern"
    } satisfies Partial<SearchError>);
    await expect(searchContainedFiles(root, "x", { maxEntries: 0 })).rejects.toMatchObject({
      code: "invalid_limit"
    } satisfies Partial<SearchError>);
  });

  it("bounds results and scanned entries with truncation metadata", async () => {
    const root = await makeTempDir();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), "x", "utf8");
    }

    const byResults = await searchContainedFiles(root, ".txt", { maxResults: 2 });
    expect(byResults.matches).toEqual(["file-0.txt", "file-1.txt"]);
    expect(byResults.truncated).toBe(true);

    const byEntries = await searchContainedFiles(root, ".txt", { maxEntries: 1 });
    expect(byEntries.scannedEntries).toBe(1);
    expect(byEntries.truncated).toBe(true);
    expect(DEFAULT_MAX_SEARCH_RESULTS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_SEARCH_ENTRIES).toBeGreaterThan(0);
  });

  it("marks results truncated when the depth boundary omits a directory", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "nested.txt"), "x", "utf8");

    const result = await searchContainedFiles(root, ".txt", { maxDepth: 0 });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("skips protected paths and symlink escape", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "secret.txt"), "secret", "utf8");
    await writeFile(join(root, ".env"), "secret", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");

    try {
      await symlink(join(outside, "outside.txt"), join(root, "leak.txt"));
    } catch {
      // Continue: protected-path assertions are still portable.
    }

    const result = await searchContainedFiles(root, ".txt");
    expect(result.matches).toEqual([]);
  });

  it("honours cancellation", async () => {
    const root = await makeTempDir();
    const controller = new AbortController();
    controller.abort();

    await expect(
      searchContainedFiles(root, "x", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
