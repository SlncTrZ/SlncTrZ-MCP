import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installStandaloneRelease,
  resolveCurrentStandaloneExecutable,
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

async function currentVersion(installRoot: string): Promise<string> {
  return (
    JSON.parse(await readFile(join(installRoot, "current.json"), "utf8")) as {
      version: string;
    }
  ).version;
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
    await expect(resolveCurrentStandaloneExecutable(installRoot)).resolves.toBe(
      join(installRoot, "versions", "1.2.3", "slnctrz-mcp")
    );
  });

  it("does not activate a mismatched first download", async () => {
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
    await expect(readdir(join(installRoot, ".staging"))).resolves.toEqual([]);
  });

  it("preserves the active release when an upgrade is interrupted or mismatched", async () => {
    const installRoot = await root();
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.0.0", Buffer.from("one")),
      target: "linux-x64",
      fetch: fetchBytes(Buffer.from("one"))
    });

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.1.0", Buffer.from("expected-two")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("tampered-two"))
      })
    ).rejects.toThrow("SHA-256");

    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
    await expect(readdir(join(installRoot, ".staging"))).resolves.toEqual([]);
  });

  it("is idempotent for the same verified version and rejects artifact substitution", async () => {
    const installRoot = await root();
    const bytes = Buffer.from("one");
    const manifest = release("1.0.0", bytes);
    const first = await installStandaloneRelease({
      installRoot,
      manifest,
      target: "linux-x64",
      fetch: fetchBytes(bytes)
    });
    const noNetwork = (async () => {
      throw new Error("network must not be called");
    }) as typeof fetch;

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest,
        target: "linux-x64",
        fetch: noNetwork
      })
    ).resolves.toEqual(first);
    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.0.0", Buffer.from("substitute")),
        target: "linux-x64",
        fetch: noNetwork
      })
    ).rejects.toThrow("different artifact");
    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
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
    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
  });

  it("fails closed on corrupt activation metadata and unsafe roots", async () => {
    const installRoot = await root();
    const bytes = Buffer.from("one");
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.0.0", bytes),
      target: "linux-x64",
      fetch: fetchBytes(bytes)
    });
    await writeFile(
      join(installRoot, "current.json"),
      JSON.stringify({
        version: "../../escape",
        target: "linux-x64",
        fileName: "slnctrz-mcp",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength
      })
    );

    await expect(resolveCurrentStandaloneExecutable(installRoot)).rejects.toThrow(
      "metadata is invalid"
    );
    await expect(
      installStandaloneRelease({
        installRoot: "relative",
        manifest: release("1.0.0", bytes),
        target: "linux-x64",
        fetch: fetchBytes(bytes)
      })
    ).rejects.toThrow("installRoot is invalid");
  });
});
