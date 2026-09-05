import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installStandaloneRelease,
  resolveCurrentStandaloneExecutable,
  rollbackStandaloneRelease,
  verifyCurrentStandaloneIntegrity
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

  it.skipIf(process.platform === "win32")(
    "publishes a service-readable executable release tree while keeping staging private",
    async () => {
      const installRoot = await root();
      const bytes = Buffer.from("verified-release");
      await installStandaloneRelease({
        installRoot,
        manifest: release("1.2.3", bytes),
        target: "linux-x64",
        fetch: fetchBytes(bytes)
      });

      expect((await stat(join(installRoot, "versions"))).mode & 0o777).toBe(0o755);
      expect((await stat(join(installRoot, "versions", "1.2.3"))).mode & 0o777).toBe(0o755);
      expect((await stat(join(installRoot, "versions", "1.2.3", "slnctrz-mcp"))).mode & 0o777).toBe(
        0o755
      );
      expect(
        (await stat(join(installRoot, "versions", "1.2.3", "release.json"))).mode & 0o777
      ).toBe(0o644);
      expect((await stat(join(installRoot, "current.json"))).mode & 0o777).toBe(0o644);
      expect((await stat(join(installRoot, ".staging"))).mode & 0o777).toBe(0o700);
    }
  );

  it("revalidates installed bytes and detects later tampering", async () => {
    const installRoot = await root();
    const bytes = Buffer.from("verified-release");
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.2.3", bytes),
      target: "linux-x64",
      fetch: fetchBytes(bytes)
    });

    await expect(verifyCurrentStandaloneIntegrity(installRoot)).resolves.toMatchObject({
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });

    await writeFile(join(installRoot, "versions", "1.2.3", "slnctrz-mcp"), "tampered");
    await expect(verifyCurrentStandaloneIntegrity(installRoot)).rejects.toThrow(/size|SHA-256/u);
  });

  it("rejects symlinked installer control directories", async () => {
    const installRoot = await root();
    const elsewhere = await root();
    await symlink(
      elsewhere,
      join(installRoot, "versions"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const bytes = Buffer.from("release-one");

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.2.3", bytes),
        target: "linux-x64",
        fetch: fetchBytes(bytes)
      })
    ).rejects.toThrow("symlink");
  });

  it("rejects artifacts above the configured product size ceiling before network access", async () => {
    const installRoot = await root();
    const bytes = Buffer.from("release-one");
    let called = false;
    const network = (async () => {
      called = true;
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.2.3", bytes),
        target: "linux-x64",
        fetch: network,
        maxArtifactBytes: bytes.byteLength - 1
      })
    ).rejects.toThrow("size ceiling");
    expect(called).toBe(false);
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

  it("keeps the active release and cleans staging after a download stream reset", async () => {
    const installRoot = await root();
    await installStandaloneRelease({
      installRoot,
      manifest: release("1.0.0", Buffer.from("one")),
      target: "linux-x64",
      fetch: fetchBytes(Buffer.from("one"))
    });
    const reset = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("partial artifact"));
            controller.error(new Error("simulated connection reset"));
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.1.0", Buffer.from("expected artifact")),
        target: "linux-x64",
        fetch: reset
      })
    ).rejects.toThrow("simulated connection reset");

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

  it("retains the active release and cleans staging when metadata publication is denied", async () => {
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
        manifest: release("1.1.0", Buffer.from("two")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("two")),
        mutations: {
          writeFile: (async (path, ...args) => {
            if (String(path).endsWith("release.json")) {
              throw Object.assign(new Error("simulated permission denial"), { code: "EACCES" });
            }
            return writeFile(path, ...args);
          }) as typeof writeFile
        }
      })
    ).rejects.toThrow("simulated permission denial");
    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
    await expect(readdir(join(installRoot, ".staging"))).resolves.toEqual([]);
    await expect(readdir(join(installRoot, "versions"))).resolves.toEqual(["1.0.0"]);
  });

  it("retains the active release when version publication rename fails", async () => {
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
        manifest: release("1.1.0", Buffer.from("two")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("two")),
        mutations: {
          rename: (async (source, destination) => {
            if (String(destination).endsWith(join("versions", "1.1.0"))) {
              throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
            }
            await rename(source, destination);
          }) as typeof rename
        }
      })
    ).rejects.toThrow("simulated rename failure");
    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
    await expect(readdir(join(installRoot, ".staging"))).resolves.toEqual([]);
    await expect(readdir(join(installRoot, "versions"))).resolves.toEqual(["1.0.0"]);
  });

  it("keeps the old activation when current metadata rename fails", async () => {
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
        manifest: release("1.1.0", Buffer.from("two")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("two")),
        mutations: {
          rename: (async (source, destination) => {
            if (String(destination).endsWith("current.json")) {
              throw Object.assign(new Error("simulated activation failure"), { code: "EIO" });
            }
            await rename(source, destination);
          }) as typeof rename
        }
      })
    ).rejects.toThrow("simulated activation failure");
    await expect(currentVersion(installRoot)).resolves.toBe("1.0.0");
    await expect(readdir(installRoot)).resolves.not.toContainEqual(
      expect.stringMatching(/^\.current\.json\..+\.tmp$/u)
    );

    await expect(
      installStandaloneRelease({
        installRoot,
        manifest: release("1.1.0", Buffer.from("two")),
        target: "linux-x64",
        fetch: fetchBytes(Buffer.from("unused"))
      })
    ).resolves.toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
  });

  it("preserves activation when rollback metadata write fails", async () => {
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

    await expect(
      rollbackStandaloneRelease({
        installRoot,
        mutations: {
          writeFile: (async () => {
            throw Object.assign(new Error("simulated disk write failure"), { code: "ENOSPC" });
          }) as typeof writeFile
        }
      })
    ).rejects.toThrow("simulated disk write failure");
    await expect(currentVersion(installRoot)).resolves.toBe("1.1.0");
  });

  it("fails closed when the rollback target disappears after activation", async () => {
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
    await rm(join(installRoot, "versions", "1.0.0", "release.json"));

    await expect(rollbackStandaloneRelease({ installRoot })).rejects.toThrow(
      "target is unavailable"
    );
    await expect(currentVersion(installRoot)).resolves.toBe("1.1.0");
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
