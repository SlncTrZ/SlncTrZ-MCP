import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_READ_BYTES,
  readContainedFile,
  type ReadError
} from "../../src/kernel/fs-read.js";

/** Scratch dirs/files, cleaned after every test. */
const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-read-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("core.read (contained filesystem read)", () => {
  it("reads a UTF-8 file inside the root", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "hello.txt"), "hello world", "utf8");

    const result = await readContainedFile(root, "hello.txt");
    expect(result.content).toBe("hello world");
    expect(result.bytes).toBe(11);
    expect(result.encoding).toBe("utf-8");
  });

  it("reads nested relative paths inside the root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.txt"), "nested", "utf8");

    const result = await readContainedFile(root, "sub/a.txt");
    expect(result.content).toBe("nested");
  });

  it("rejects when no filesystem root is configured (default-deny)", async () => {
    await expect(readContainedFile(undefined, "x.txt")).rejects.toMatchObject({
      code: "no_root"
    } satisfies Partial<ReadError>);
  });

  it("rejects an absolute path", async () => {
    const root = await makeTempDir();
    await expect(readContainedFile(root, "/etc/hosts")).rejects.toMatchObject({
      code: "invalid_path"
    } satisfies Partial<ReadError>);
  });

  it("rejects traversal outside the root", async () => {
    const root = await makeTempDir();
    await expect(readContainedFile(root, "../outside.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<ReadError>);
  });

  it("rejects a symlink that escapes the root", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // symlinks unsupported here (e.g. Windows without Developer Mode); path not exercisable
    }

    await expect(readContainedFile(root, "link.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<ReadError>);
  });

  it("rejects a non-existent path", async () => {
    const root = await makeTempDir();
    await expect(readContainedFile(root, "missing.txt")).rejects.toMatchObject({
      code: "not_found"
    } satisfies Partial<ReadError>);
  });

  it("enforces the byte-size limit", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "big.txt"), "x".repeat(1_000), "utf8");

    await expect(readContainedFile(root, "big.txt", 100)).rejects.toMatchObject({
      code: "too_large"
    } satisfies Partial<ReadError>);
    // Default limit is a positive, explicit bound.
    expect(DEFAULT_MAX_READ_BYTES).toBeGreaterThan(0);
  });

  it("rejects a non-positive size limit", async () => {
    const root = await makeTempDir();
    await expect(readContainedFile(root, "x.txt", 0)).rejects.toMatchObject({
      code: "invalid_limit"
    } satisfies Partial<ReadError>);
  });
});
