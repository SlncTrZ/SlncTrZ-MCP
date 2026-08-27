import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_READ_BYTES,
  readContainedFile,
  type ReadError
} from "../../src/kernel/fs-read.js";

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
  it("reads strict UTF-8 files inside the root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "hello.txt"), "xin chào", "utf8");

    const result = await readContainedFile(root, "sub/hello.txt");
    expect(result).toEqual({
      content: "xin chào",
      bytes: Buffer.byteLength("xin chào"),
      encoding: "utf-8"
    });
  });

  it("rejects default-deny, absolute, traversal, and missing paths", async () => {
    const root = await makeTempDir();

    await expect(readContainedFile(undefined, "x.txt")).rejects.toMatchObject({
      code: "no_root"
    } satisfies Partial<ReadError>);
    await expect(readContainedFile(root, "/etc/hosts")).rejects.toMatchObject({
      code: "invalid_path"
    } satisfies Partial<ReadError>);
    await expect(readContainedFile(root, "../outside.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<ReadError>);
    await expect(readContainedFile(root, "missing.txt")).rejects.toMatchObject({
      code: "not_found"
    } satisfies Partial<ReadError>);
  });

  it("rejects symlink escape and protected paths", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await writeFile(join(root, ".env"), "secret", "utf8");

    await expect(readContainedFile(root, ".env")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<ReadError>);

    try {
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return;
    }
    await expect(readContainedFile(root, "link.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<ReadError>);
  });

  it("enforces byte limits before and during handle reads", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "big.txt"), "x".repeat(1_000), "utf8");

    await expect(readContainedFile(root, "big.txt", 100)).rejects.toMatchObject({
      code: "too_large"
    } satisfies Partial<ReadError>);
    expect(DEFAULT_MAX_READ_BYTES).toBeGreaterThan(0);
  });

  it("rejects invalid UTF-8 rather than replacing bytes", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    await expect(readContainedFile(root, "invalid.txt")).rejects.toMatchObject({
      code: "invalid_encoding"
    } satisfies Partial<ReadError>);
  });

  it("honours cancellation and validates limits", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.txt"), "a", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(
      readContainedFile(root, "a.txt", DEFAULT_MAX_READ_BYTES, { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(readContainedFile(root, "a.txt", 0)).rejects.toMatchObject({
      code: "invalid_limit"
    } satisfies Partial<ReadError>);
  });
});
