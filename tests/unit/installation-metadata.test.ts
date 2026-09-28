import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readInstallationMetadata,
  writeInstallationMetadata
} from "../../src/standalone/installation-metadata.js";

const cleanup: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "slnctrz-installation-metadata-"));
  cleanup.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installation metadata", () => {
  it("supports concurrent atomic writes even when Date.now collides", async () => {
    const dir = await root();
    const path = join(dir, "installation.json");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const input = {
      installMode: "user" as const,
      installRoot: join(dir, "install"),
      stateRoot: join(dir, "state"),
      configRoot: join(dir, "config"),
      serviceMode: "foreground" as const,
      serviceName: "slnctrz-mcp",
      releaseChannel: "stable",
      host: "127.0.0.1",
      port: 3100,
      authorityMode: "restricted" as const,
      initialPath: dir
    };

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => writeInstallationMetadata(path, input))
    );

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    await expect(readInstallationMetadata(path)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      serviceName: "slnctrz-mcp",
      releaseChannel: "stable"
    });
  });
});
