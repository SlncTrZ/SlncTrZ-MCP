import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWithin } from "../../src/protocol/mcp-server.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

describe("restricted multi-root search wrapper", () => {
  it("enforces one global result budget across roots", async () => {
    const a = await root("slnctrz-search-budget-a-");
    const b = await root("slnctrz-search-budget-b-");
    await writeFile(join(a, "a1.txt"), "x", "utf8");
    await writeFile(join(a, "a2.txt"), "x", "utf8");
    await writeFile(join(b, "b1.txt"), "x", "utf8");
    await writeFile(join(b, "b2.txt"), "x", "utf8");

    const result = await searchWithin([a, b], a, ".txt", 2, 100);

    expect(result.matches).toHaveLength(2);
    expect(result.matches).toEqual(["a1.txt", "a2.txt"]);
    expect(result.truncated).toBe(true);
  });

  it("never exceeds the global scanned-entry budget across roots", async () => {
    const a = await root("slnctrz-search-entry-a-");
    const b = await root("slnctrz-search-entry-b-");
    await writeFile(join(a, "a1.txt"), "x", "utf8");
    await writeFile(join(a, "a2.txt"), "x", "utf8");
    await writeFile(join(b, "b1.txt"), "x", "utf8");
    await writeFile(join(b, "b2.txt"), "x", "utf8");

    const result = await searchWithin([a, b], a, ".txt", 100, 3);

    expect(result.scannedEntries).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
  });

  it("preserves provenance when duplicate relative paths exist in different roots", async () => {
    const a = await root("slnctrz-search-provenance-a-");
    const b = await root("slnctrz-search-provenance-b-");
    await writeFile(join(a, "same.txt"), "a", "utf8");
    await writeFile(join(b, "same.txt"), "b", "utf8");

    const result = await searchWithin([a, b], a, "same.txt", 100, 100);

    expect(result.matches).toEqual(["same.txt"]);
    expect(result.resolvedMatches).toEqual([
      { root: a, path: "same.txt" },
      { root: b, path: "same.txt" }
    ]);
  });

  it("rejects an explicit root outside configured Paths", async () => {
    const a = await root("slnctrz-search-authorized-");
    const outside = await root("slnctrz-search-outside-");

    await expect(searchWithin([a], a, "*", 100, 100, { root: outside })).rejects.toMatchObject({
      code: "permission_denied"
    });
  });

  it("honors cancellation before scanning", async () => {
    const a = await root("slnctrz-search-cancel-");
    const controller = new AbortController();
    controller.abort();

    await expect(
      searchWithin([a], a, "*", 100, 100, { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
