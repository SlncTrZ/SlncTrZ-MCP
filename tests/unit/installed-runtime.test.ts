import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInstalledRuntimeEnvironment,
  samePlatformPath
} from "../../src/standalone/installed-runtime.js";
import { writeInstallationMetadata } from "../../src/standalone/installation-metadata.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-installed-runtime-"));
  cleanup.push(root);
  const installRoot = join(root, "install");
  const stateRoot = join(root, "state");
  const configRoot = join(root, "config");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(workspace, { recursive: true })
  ]);
  const installation = await writeInstallationMetadata(join(stateRoot, "installation.json"), {
    installMode: "user",
    installRoot,
    stateRoot,
    configRoot,
    serviceMode: "foreground",
    serviceName: "slnctrz-mcp",
    releaseChannel: "stable",
    host: "127.0.0.1",
    port: 43210,
    authorityMode: "restricted",
    initialPath: workspace
  });
  await writeFile(
    join(installRoot, "installation-marker.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      installationId: installation.installationId,
      stateRoot
    })}\n`,
    "utf8"
  );
  await writeFile(
    join(configRoot, "gateway.env"),
    ["SLNCTRZ_HOST=127.0.0.1", "SLNCTRZ_PORT=43210", `SLNCTRZ_STATE_ROOT=${stateRoot}`, ""].join(
      "\n"
    ),
    "utf8"
  );
  return { installRoot, stateRoot };
}

describe("installed Windows runtime environment", () => {
  it("compares resolved Windows installation paths case-insensitively", () => {
    expect(samePlatformPath("/Users/Alice/AppData", "/users/alice/appdata", "win32")).toBe(true);
    expect(samePlatformPath("/Users/Alice/AppData", "/users/alice/appdata", "linux")).toBe(false);
  });

  it("loads managed config when the top-level native launcher identity matches", async () => {
    const f = await fixture();
    const environment: NodeJS.ProcessEnv = {};
    await expect(
      applyInstalledRuntimeEnvironment({
        platform: "win32",
        executablePath: join(f.installRoot, "slnctrz-mcp.exe"),
        environment
      })
    ).resolves.toBe(true);
    expect(environment).toMatchObject({
      SLNCTRZ_HOST: "127.0.0.1",
      SLNCTRZ_PORT: "43210",
      SLNCTRZ_STATE_ROOT: f.stateRoot
    });
  });

  it("does nothing outside an installed launcher root", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-uninstalled-runtime-"));
    cleanup.push(root);
    await expect(
      applyInstalledRuntimeEnvironment({
        platform: "win32",
        executablePath: join(root, "slnctrz-mcp.exe"),
        environment: {}
      })
    ).resolves.toBe(false);
  });
});
