import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installStandaloneRelease,
  rollbackStandaloneRelease
} from "../../src/standalone/installer.js";
import type { ReleaseManifest } from "../../src/standalone/release-manifest.js";

const cleanup: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "slnctrz-standalone-"));
  cleanup.push(value);
  return value;
}

function release(version: string, bytes: Buffer): ReleaseManifest {
  return {
    schemaVersion: 1,
    version,
    artifacts: [
      {
        target: "linux-x64",
        url: `https://downloads.example.test/${version}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        fileName: "slnctrz-mcp"
      }
    ]
  };
}

function fetchBytes(bytes: Buffer): typeof fetch {
  return (async () => new Response(bytes, { status: 200 })) as typeof fetch;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("standalone installer", () => {
  it("verifies the artifact before atomically activating a versioned install", async () => {
    const installRoot = await root();
    const bytes = Buffer.from("release-one");
    const result = await installStandaloneRelease({
      installRoot,
      manifest: release("1.2.3", bytes),
      target: "linux-x64",
      fetch: fetchBytes(bytes)
    });

    expect(result).toMatchObject({ version: "1.2.3" });
    expect(result.previousVersion).toBeUndefined();
    expect(await readFile(join(installRoot, "versions", "1.2.3", "slnctrz-mcp"))).toEqual(bytes);
    expect(JSON.parse(await readFile(join(installRoot, "current.json"), "utf8"))).toMatchObject({
      version: "1.2.3"
    });
  });

  it("does not activate a mismatched download", async () => {
    const installRoot = await root();
    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.2.3", Buffer.from("expected")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("tampered"))
      })
    ).rejects.toThrow("SHA-256");
    await expect(readFile(join(installRoot, "current.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rolls back atomically to the previous verified version", async () => {
    const installRoot = await root();
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.0.0", Buffer.from("one")),
      target: "linux-x64",
      fetch: fetchBytes(Buffer.from("one"))
    });
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.1.0", Buffer.from("two")),
      target: "linux-x64",
      fetch: fetchBytes(Buffer.from("two"))
    });

    expect(await rollbackStandaloneRelease({ installRoot })).toMatchObject({ version: "1.0.0" });
    expect(JSON.parse(await readFile(join(installRoot, "current.json"), "utf8"))).toMatchObject({
      version: "1.0.0"
    });
  });
});
