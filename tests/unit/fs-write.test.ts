import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_WRITE_BYTES,
  WriteError,
  writeContainedFile
} from "../../src/kernel/fs-write.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-write-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("core.write (atomic contained filesystem write)", () => {
  it("defaults to dry-run without creating a file", async () => {
    const root = await makeTempDir();

    const result = await writeContainedFile(root, "new.txt", "hello");
    expect(result).toEqual(
      expect.objectContaining({
        path: "new.txt",
        bytes: 5,
        created: true,
        applied: false
      })
    );
    await expect(lstat(join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically creates a new file and removes temporary artifacts", async () => {
    const root = await makeTempDir();

    const result = await writeContainedFile(root, "new.txt", "hello", { dryRun: false });
    expect(result.created).toBe(true);
    expect(result.applied).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("hello");
    expect((await readdir(root)).filter((name) => name.includes(".slnctrz-write-"))).toEqual([]);
  });

  it("requires the expected hash to overwrite and preserves file mode", async () => {
    const root = await makeTempDir();
    const target = join(root, "existing.txt");
    await writeFile(target, "old", "utf8");
    await chmod(target, 0o640);

    const preview = await writeContainedFile(root, "existing.txt", "new");
    const expectedSha256 = preview.previousSha256;
    if (expectedSha256 === undefined) throw new Error("preview omitted previousSha256");
    expect(expectedSha256).toMatch(/^[a-f0-9]{64}$/u);

    await expect(
      writeContainedFile(root, "existing.txt", "new", { dryRun: false })
    ).rejects.toMatchObject({ code: "expected_hash_required" } satisfies Partial<WriteError>);

    const result = await writeContainedFile(root, "existing.txt", "new", {
      dryRun: false,
      expectedSha256
    });
    expect(result.created).toBe(false);
    expect(result.applied).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
    if (process.platform !== "win32") {
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
    }
  });

  it("serializes concurrent replacements against one expected hash", async () => {
    const root = await makeTempDir();
    const target = join(root, "existing.txt");
    await writeFile(target, "base", "utf8");
    const preview = await writeContainedFile(root, "existing.txt", "candidate");
    const expectedSha256 = preview.previousSha256;
    if (expectedSha256 === undefined) throw new Error("preview omitted previousSha256");

    const outcomes = await Promise.all(
      ["first", "second"].map(async (content) => {
        try {
          await writeContainedFile(root, "existing.txt", content, {
            dryRun: false,
            expectedSha256
          });
          return "success" as const;
        } catch (error) {
          if (error instanceof WriteError) return error.code;
          throw error;
        }
      })
    );

    expect([...outcomes].sort()).toEqual(["conflict", "success"]);
    expect(["first", "second"]).toContain(await readFile(target, "utf8"));
    expect((await readdir(root)).filter((name) => name.includes(".slnctrz-write"))).toEqual([]);
  });

  it("rejects stale hashes without changing the target", async () => {
    const root = await makeTempDir();
    const target = join(root, "existing.txt");
    await writeFile(target, "current", "utf8");

    await expect(
      writeContainedFile(root, "existing.txt", "replacement", {
        dryRun: false,
        expectedSha256: "0".repeat(64)
      })
    ).rejects.toMatchObject({ code: "conflict" } satisfies Partial<WriteError>);
    expect(await readFile(target, "utf8")).toBe("current");
  });

  it("rejects traversal, protected paths, symlinks, and oversized content", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");

    await expect(writeContainedFile(root, "../escape.txt", "x")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<WriteError>);
    await expect(writeContainedFile(root, ".env", "x")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<WriteError>);
    await expect(
      writeContainedFile(root, "large.txt", "x".repeat(DEFAULT_MAX_WRITE_BYTES + 1))
    ).rejects.toMatchObject({ code: "too_large" } satisfies Partial<WriteError>);

    try {
      await symlink(join(outside, "outside.txt"), join(root, "link.txt"));
    } catch {
      return;
    }
    await expect(writeContainedFile(root, "link.txt", "x")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<WriteError>);
  });

  it("honours cancellation before mutation", async () => {
    const root = await makeTempDir();
    const controller = new AbortController();
    controller.abort();

    await expect(
      writeContainedFile(root, "cancelled.txt", "x", {
        dryRun: false,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(lstat(join(root, "cancelled.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
