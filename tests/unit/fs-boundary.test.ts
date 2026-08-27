import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBoundaryRoot,
  resolveExistingBoundaryPath,
  type BoundaryError
} from "../../src/kernel/fs-boundary.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-boundary-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("filesystem boundary", () => {
  it("resolves an existing contained path", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {};", "utf8");

    const result = await resolveExistingBoundaryPath(root, "src/index.ts");
    expect(result.relativePath).toBe("src/index.ts");
  });

  it("rejects lexical and symlink escape", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");

    await expect(resolveExistingBoundaryPath(root, "../outside.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<BoundaryError>);

    try {
      await symlink(join(outside, "outside.txt"), join(root, "link.txt"));
    } catch {
      return;
    }
    await expect(resolveExistingBoundaryPath(root, "link.txt")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<BoundaryError>);
  });

  it("denies protected paths even inside an allowed root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "protected", "utf8");
    await writeFile(join(root, ".env.local"), "protected", "utf8");

    await expect(resolveExistingBoundaryPath(root, ".git/config")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<BoundaryError>);
    await expect(resolveExistingBoundaryPath(root, ".env.local")).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<BoundaryError>);
  });

  it("rejects a configured root inside a protected directory", async () => {
    const parent = await makeTempDir();
    const root = join(parent, ".ssh");
    await mkdir(root);

    await expect(resolveBoundaryRoot(root)).rejects.toMatchObject({
      code: "permission_denied"
    } satisfies Partial<BoundaryError>);
  });

  it("rejects cross-platform absolute path forms and NUL bytes", async () => {
    const root = await makeTempDir();
    for (const candidate of ["/etc/hosts", "C:\\Windows\\win.ini", "\\\\server\\share", "a\0b"]) {
      await expect(resolveExistingBoundaryPath(root, candidate)).rejects.toMatchObject({
        code: "invalid_path"
      } satisfies Partial<BoundaryError>);
    }
  });
});
