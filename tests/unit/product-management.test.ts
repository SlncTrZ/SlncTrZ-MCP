import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userPlatformLayout } from "../../src/standalone/platform-layout.js";
import { currentReleaseTarget } from "../../src/standalone/release-manifest.js";
import { prepareProductSetup } from "../../src/standalone/product-setup.js";
import {
  readProductStatus,
  repairProduct,
  rollbackProduct,
  rotateOwnerPassphrase,
  runDoctor,
  setProductConfig,
  showProductConfig,
  uninstallProduct,
  updateProduct
} from "../../src/standalone/product-management.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(value);
  return value;
}

function manifest(version: string, bytes: Buffer): string {
  return JSON.stringify({
    schemaVersion: 1,
    version,
    artifacts: [
      {
        target: currentReleaseTarget(),
        url: `https://objects.example.test/${version}/slnctrz-mcp`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        fileName: process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
      }
    ]
  });
}

function releaseFetch(releases: Readonly<Record<string, Buffer>>): typeof fetch {
  return (async (input) => {
    const url = String(input);
    const version = Object.keys(releases).find((entry) => url.includes(entry)) ?? "1.0.0";
    const bytes = releases[version];
    if (bytes === undefined) return new Response("missing", { status: 404 });
    if (url.includes("manifest")) return new Response(manifest(version, bytes), { status: 200 });
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
}

async function fixture() {
  const root = await directory("slnctrz-management-");
  const workspace = await directory("slnctrz-management-workspace-");
  const installRoot = join(root, "install");
  const stateRoot = join(root, "state");
  const configRoot = join(root, "config");
  const releases = {
    "1.0.0": Buffer.from("#!/bin/sh\necho one\n"),
    "1.1.0": Buffer.from("#!/bin/sh\necho two\n")
  };
  const fetch = releaseFetch(releases);
  await prepareProductSetup(
    {
      installMode: "user",
      port: 9150,
      initialPath: workspace,
      manifestUrl: "https://updates.example.test/1.0.0/manifest.json",
      installRoot,
      stateRoot,
      configRoot
    },
    { fetch, checkPort: async () => undefined }
  );
  return { root, workspace, installRoot, stateRoot, configRoot, fetch };
}

describe("installed product management", () => {
  it("reports status and read-only diagnostics without exposing secrets", async () => {
    const f = await fixture();
    const management = {
      stateRoot: f.stateRoot,
      fetch: (async () => new Response('{"status":"ok"}', { status: 200 })) as typeof fetch
    };
    const status = await readProductStatus(management);
    expect(status).toMatchObject({
      version: "1.0.0",
      installMode: "user",
      authorityMode: "restricted",
      commands: 0,
      installedIntegrity: "ok",
      gateway: "running"
    });
    expect(JSON.stringify(status)).not.toContain("Owner Passphrase:");

    const beforePolicy = await readFile(join(f.stateRoot, "policy.json"), "utf8");
    const diagnostics = await runDoctor(management);
    expect(diagnostics.some((item) => item.code === "installed_release_integrity_ok")).toBe(true);
    expect(diagnostics.some((item) => item.code === "policy_valid")).toBe(true);
    expect(await readFile(join(f.stateRoot, "policy.json"), "utf8")).toBe(beforePolicy);
  });

  it("detects a running-version mismatch through the configured authenticated control port", async () => {
    const f = await fixture();
    await writeFile(
      join(f.configRoot, "gateway.env"),
      [
        "SLNCTRZ_HOST=127.0.0.1",
        "SLNCTRZ_PORT=9150",
        "SLNCTRZ_OWNER_WEB_ENABLED=true",
        "SLNCTRZ_CONTROL_HOST=127.0.0.1",
        "SLNCTRZ_CONTROL_PORT=3999",
        `SLNCTRZ_STATE_ROOT=${f.stateRoot}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const passphrase = (
      await readFile(join(f.stateRoot, "secrets", "owner-passphrase"), "utf8")
    ).trim();
    const identityFetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response('{"status":"ok"}', { status: 200 });
      if (url.endsWith(":3999/status")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${passphrase}`);
        return new Response(
          JSON.stringify({
            status: "ok",
            version: "9.9.9",
            buildCommit: "running-build",
            authorityMode: "restricted"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;

    const status = await readProductStatus({ stateRoot: f.stateRoot, fetch: identityFetch });
    expect(status).toMatchObject({
      version: "1.0.0",
      runningVersion: "9.9.9",
      runningBuildCommit: "running-build",
      versionMismatch: true
    });
    const diagnostics = await runDoctor({ stateRoot: f.stateRoot, fetch: identityFetch });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: "FAIL", code: "running_version_mismatch" })
    );
  });

  it("validates config changes, preserves advanced non-secret keys, and can return to local mode", async () => {
    const f = await fixture();
    await writeFile(
      join(f.configRoot, "gateway.env"),
      [
        "SLNCTRZ_HOST=127.0.0.1",
        "SLNCTRZ_PORT=9150",
        "SLNCTRZ_OWNER_WEB_ENABLED=true",
        "SLNCTRZ_MAX_DYNAMIC_CLIENTS=2048",
        "SLNCTRZ_CONTROL_HOST=127.0.0.1",
        "SLNCTRZ_CONTROL_PORT=3998",
        "SLNCTRZ_TELEMETRY_ENABLED=false",
        "SLNCTRZ_ALLOWED_HOSTS=localhost,127.0.0.1",
        "SLNCTRZ_ALLOWED_ORIGINS=localhost,127.0.0.1",
        `SLNCTRZ_STATE_ROOT=${f.stateRoot}`,
        ""
      ].join("\n"),
      "utf8"
    );
    const management = { stateRoot: f.stateRoot, fetch: f.fetch };
    await setProductConfig("port", "9160", management);
    const persistedAdvanced = await readFile(join(f.configRoot, "gateway.env"), "utf8");
    expect(persistedAdvanced).toContain("SLNCTRZ_MAX_DYNAMIC_CLIENTS=2048");
    expect(persistedAdvanced).toContain("SLNCTRZ_CONTROL_PORT=3998");
    expect(persistedAdvanced).toContain("SLNCTRZ_TELEMETRY_ENABLED=false");
    await setProductConfig("public-url", "https://mcp.example.test/mcp", management);
    const publicConfig = await readFile(join(f.configRoot, "gateway.env"), "utf8");
    expect(publicConfig).toContain("SLNCTRZ_ALLOWED_HOSTS=localhost,127.0.0.1,mcp.example.test");
    expect(publicConfig).toContain("SLNCTRZ_ALLOWED_ORIGINS=localhost,127.0.0.1,mcp.example.test");
    expect(await showProductConfig(management)).toMatchObject({
      port: 9160,
      accessMode: "public",
      publicMcpUrl: "https://mcp.example.test/mcp"
    });

    await setProductConfig("public-url", "local", management);
    expect(await showProductConfig(management)).toMatchObject({
      port: 9160,
      accessMode: "local",
      publicMcpUrl: "http://127.0.0.1:9160/mcp"
    });
    const installation = JSON.parse(
      await readFile(join(f.stateRoot, "installation.json"), "utf8")
    ) as { publicMcpUrl?: string };
    expect(installation.publicMcpUrl).toBeUndefined();
  });

  it("updates and rolls back immutable releases without losing state", async () => {
    const f = await fixture();
    const management = { stateRoot: f.stateRoot, fetch: f.fetch };
    const passphraseBefore = await readFile(
      join(f.stateRoot, "secrets", "owner-passphrase"),
      "utf8"
    );

    const updated = await updateProduct(
      { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
      management
    );
    expect(updated.activation.version).toBe("1.1.0");
    expect(updated.restartRequired).toBe(true);

    const rolled = await rollbackProduct(management);
    expect(rolled.activation.version).toBe("1.0.0");
    expect(await readFile(join(f.stateRoot, "secrets", "owner-passphrase"), "utf8")).toBe(
      passphraseBefore
    );
  });

  it.skipIf(process.platform === "win32")(
    "doctor detects broad managed-state modes and repair reasserts privacy",
    async () => {
      const f = await fixture();
      for (const path of [
        f.stateRoot,
        join(f.stateRoot, "mcp"),
        join(f.stateRoot, "mcp", "credentials"),
        join(f.stateRoot, "secrets")
      ]) {
        await chmod(path, 0o755);
      }

      const before = await runDoctor({ stateRoot: f.stateRoot, fetch: f.fetch });
      expect(before).toContainEqual(
        expect.objectContaining({ level: "FAIL", code: "state_root_permissions_unsafe" })
      );

      const repaired = await repairProduct({ stateRoot: f.stateRoot, fetch: f.fetch });
      expect(repaired.changes).toContain("fixed_managed_state_modes");
      for (const path of [
        f.stateRoot,
        join(f.stateRoot, "mcp"),
        join(f.stateRoot, "mcp", "credentials"),
        join(f.stateRoot, "secrets")
      ]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
    }
  );

  it("repairs only safe non-secret defaults and never regenerates a missing owner secret", async () => {
    const f = await fixture();
    const management = { stateRoot: f.stateRoot, fetch: f.fetch };
    await rm(join(f.stateRoot, "command.json"));
    await rm(join(f.installRoot, userPlatformLayout().launcherFileName));
    await rm(join(f.stateRoot, "secrets", "owner-passphrase"));

    const result = await repairProduct(management);
    expect(result.changes).toContain("restored_launcher");
    expect(result.changes).toContain("restored_minimal_command_catalog");
    await expect(access(join(f.stateRoot, "secrets", "owner-passphrase"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rotates the owner passphrase explicitly and requires restart", async () => {
    const f = await fixture();
    const before = await readFile(join(f.stateRoot, "secrets", "owner-passphrase"), "utf8");
    const result = await rotateOwnerPassphrase({ stateRoot: f.stateRoot });
    const after = await readFile(join(f.stateRoot, "secrets", "owner-passphrase"), "utf8");
    expect(result.restartRequired).toBe(true);
    expect(result.passphrase).toHaveLength(32);
    expect(after).not.toBe(before);
    expect(after.trim()).toBe(result.passphrase);
  });

  it("uninstalls program-only by default and preserves config/state", async () => {
    const f = await fixture();
    const result = await uninstallProduct({}, { stateRoot: f.stateRoot, fetch: f.fetch });
    expect(result.statePreserved).toBe(true);
    await expect(access(f.installRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(f.stateRoot)).resolves.toBeUndefined();
    await expect(access(f.configRoot)).resolves.toBeUndefined();
  });

  it("doctor reports tampered release bytes instead of repairing them silently", async () => {
    const f = await fixture();
    await writeFile(
      join(
        f.installRoot,
        "versions",
        "1.0.0",
        process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
      ),
      "tampered"
    );
    const items = await runDoctor({ stateRoot: f.stateRoot, fetch: f.fetch });
    expect(items).toContainEqual(
      expect.objectContaining({ level: "FAIL", code: "installed_release_integrity_failed" })
    );
  });
});
