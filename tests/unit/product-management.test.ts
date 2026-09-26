import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
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
import { TEST_RELEASE_TRUST_KEYS, signedManifestResponse } from "../helpers/release-signing.js";

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
    return signedManifestResponse(input, manifest(version, bytes), bytes);
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
    { fetch, checkPort: async () => undefined, releaseTrustKeys: TEST_RELEASE_TRUST_KEYS }
  );
  return { root, workspace, installRoot, stateRoot, configRoot, fetch };
}

async function rollbackCompatibilityFixture() {
  const root = await directory("slnctrz-management-rollback-compat-");
  const workspace = await directory("slnctrz-management-rollback-workspace-");
  const installRoot = join(root, "install");
  const stateRoot = join(root, "state");
  const configRoot = join(root, "config");
  const releases = {
    "0.2.10": Buffer.from("#!/bin/sh\necho v0.2.10\n"),
    "0.3.0": Buffer.from("#!/bin/sh\necho v0.3.0\n")
  };
  const fetch = releaseFetch(releases);
  await prepareProductSetup(
    {
      installMode: "user",
      port: 9150,
      initialPath: workspace,
      manifestUrl: "https://updates.example.test/0.2.10/manifest.json",
      installRoot,
      stateRoot,
      configRoot
    },
    { fetch, checkPort: async () => undefined, releaseTrustKeys: TEST_RELEASE_TRUST_KEYS }
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
      installedIntegrity: "ok",
      gateway: "running"
    });
    expect(status.commands).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain("Owner Passphrase:");

    const beforePolicy = await readFile(join(f.stateRoot, "policy.json"), "utf8");
    const diagnostics = await runDoctor(management);
    expect(diagnostics.some((item) => item.code === "installed_release_integrity_ok")).toBe(true);
    expect(diagnostics.some((item) => item.code === "policy_valid")).toBe(true);
    expect(await readFile(join(f.stateRoot, "policy.json"), "utf8")).toBe(beforePolicy);
    // Windows CI runners can exceed the default 5s timeout on fixture + doctor I/O.
  }, 15_000);

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
    const management = {
      stateRoot: f.stateRoot,
      fetch: f.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    };
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

  it("blocks an incompatible custom-harness rollback before activation while default rollback remains valid", async () => {
    const defaultInstall = await rollbackCompatibilityFixture();
    const defaultManagement = {
      stateRoot: defaultInstall.stateRoot,
      fetch: defaultInstall.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    };
    await updateProduct(
      { manifestUrl: "https://updates.example.test/0.3.0/manifest.json" },
      defaultManagement
    );
    await expect(rollbackProduct(defaultManagement)).resolves.toMatchObject({
      activation: { version: "0.2.10" }
    });

    const customInstall = await rollbackCompatibilityFixture();
    const customManagement = {
      stateRoot: customInstall.stateRoot,
      fetch: customInstall.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    };
    await updateProduct(
      { manifestUrl: "https://updates.example.test/0.3.0/manifest.json" },
      customManagement
    );
    const gatewayConfigFile = join(customInstall.configRoot, "gateway.env");
    const customHarness = join(customInstall.root, "custom-harness");
    const configBefore = `${await readFile(gatewayConfigFile, "utf8")}SLNCTRZ_HARNESS_ROOT=${customHarness}\n`;
    await writeFile(gatewayConfigFile, configBefore, "utf8");
    const activationFile = join(customInstall.installRoot, "current.json");
    const activationBefore = await readFile(activationFile, "utf8");

    await expect(rollbackProduct(customManagement)).rejects.toThrow(
      "rollback_config_incompatible: SLNCTRZ_HARNESS_ROOT"
    );
    expect(await readFile(activationFile, "utf8")).toBe(activationBefore);
    expect(await readFile(gatewayConfigFile, "utf8")).toBe(configBefore);
  });

  it("rejects a tampered signed manifest before artifact download or activation", async () => {
    const f = await fixture();
    const activationFile = join(f.installRoot, "current.json");
    const activationBefore = await readFile(activationFile, "utf8");
    let artifactRequests = 0;
    const tamperedFetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url = String(input);
      if (url === "https://updates.example.test/1.1.0/manifest.json") {
        const response = await f.fetch(input, init);
        const original = await response.text();
        return new Response(original.replace('"version":"1.1.0"', '"version":"1.1.1"'), {
          status: response.status,
          headers: response.headers
        });
      }
      if (url.includes("objects.example.test")) artifactRequests += 1;
      return f.fetch(input, init);
    }) as typeof fetch;

    await expect(
      updateProduct(
        { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
        {
          stateRoot: f.stateRoot,
          fetch: tamperedFetch,
          releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
        }
      )
    ).rejects.toThrow("verification failed");

    expect(artifactRequests).toBe(0);
    expect(await readFile(activationFile, "utf8")).toBe(activationBefore);
  });

  it("updates and rolls back immutable releases while preserving OAuth config", async () => {
    const f = await fixture();
    const management = {
      stateRoot: f.stateRoot,
      fetch: f.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    };
    const clientSecret = "legacy-client-secret";
    await writeFile(
      join(f.configRoot, "client.env"),
      [
        "SLNCTRZ_CLIENT_ID=slnctrz-mcp",
        `SLNCTRZ_CLIENT_SECRET=${clientSecret}`,
        "SLNCTRZ_CLIENT_NAME=SlncTrZ-MCP",
        "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback",
        ""
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 }
    );
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
    const migratedClient = await readFile(join(f.configRoot, "client.env"), "utf8");
    expect(migratedClient).toContain(`SLNCTRZ_CLIENT_SECRET=${clientSecret}`);
    expect(migratedClient).toContain(
      "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback"
    );
    expect(migratedClient).not.toContain("user_bound_custom-mcp");

    const rolled = await rollbackProduct(management);
    expect(rolled.activation.version).toBe("1.0.0");
    expect(await readFile(join(f.stateRoot, "secrets", "owner-passphrase"), "utf8")).toBe(
      passphraseBefore
    );
  });

  it.skipIf(process.platform !== "linux")(
    "does not strand the running legacy service when an update fails after migration preflight",
    async () => {
      const f = await fixture();
      const metadataFile = join(f.stateRoot, "installation.json");
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
      metadata.installMode = "system";
      metadata.serviceMode = "systemd";
      await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const serviceUnitRoot = await directory("slnctrz-management-preflight-");
      await writeFile(
        join(serviceUnitRoot, "slnctrz-mcp.service"),
        "[Service]\nUser=slnctrz\nGroup=slnctrz\nExecStart=/legacy/slnctrz-mcp\n",
        "utf8"
      );
      let stateOwner = "slnctrz";
      const calls: string[] = [];
      const run = async (command: string, args: readonly string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "chown" && args.at(-1) === f.stateRoot) {
          stateOwner = String(args[1]).split(":", 1)[0] ?? stateOwner;
        }
        return {
          code: 0,
          stdout: command === "systemctl" && args[0] === "is-system-running" ? "running\n" : "",
          stderr: ""
        };
      };
      const failingFetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        const url = String(input);
        if (url.includes("manifest")) return f.fetch(input, init);
        return new Response("artifact download failed", { status: 500 });
      }) as typeof fetch;

      await expect(
        updateProduct(
          { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
          {
            stateRoot: f.stateRoot,
            fetch: failingFetch,
            run,
            serviceUnitRoot,
            isRoot: () => true,
            sleep: async () => undefined,
            releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
          }
        )
      ).rejects.toThrow("Standalone artifact download failed");

      expect(stateOwner, "legacy service must retain state access after failed update").toBe(
        "slnctrz"
      );
      expect(calls.some((call) => call.startsWith(`chown -R ${userInfo().username}:`))).toBe(false);
      expect(
        JSON.parse((await readFile(join(f.installRoot, "current.json"), "utf8")) as string) as {
          version: string;
        }
      ).toMatchObject({ version: "1.0.0" });
    }
  );

  it.skipIf(process.platform !== "linux")(
    "rolls back state ownership, unit identity, and active release when restart fails after migration",
    async () => {
      const f = await fixture();
      const metadataFile = join(f.stateRoot, "installation.json");
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
      metadata.installMode = "system";
      metadata.serviceMode = "systemd";
      await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const serviceUnitRoot = await directory("slnctrz-management-rollback-");
      const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
      const legacyUnit = "[Service]\nUser=slnctrz\nGroup=slnctrz\nExecStart=/legacy/slnctrz-mcp\n";
      await writeFile(unitFile, legacyUnit, "utf8");
      let stateOwner = "slnctrz";
      let restartCount = 0;
      const ownershipTransitions: string[] = [];
      const effectiveUnitValue = async (key: "User" | "Group") => {
        const unit = await readFile(unitFile, "utf8");
        return new RegExp(`^${key}=([^\\r\\n]+)`, "m").exec(unit)?.[1] ?? "";
      };
      const run = async (command: string, args: readonly string[]) => {
        if (command === "systemctl" && args[0] === "is-system-running") {
          return { code: 0, stdout: "running\n", stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=User")) {
          return { code: 0, stdout: `${await effectiveUnitValue("User")}\n`, stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=Group")) {
          return { code: 0, stdout: `${await effectiveUnitValue("Group")}\n`, stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=MainPID")) {
          return { code: 0, stdout: "8100\n", stderr: "" };
        }
        if (command === "chown" && args.at(-1) === f.stateRoot) {
          stateOwner = String(args[1]).split(":", 1)[0] ?? stateOwner;
          ownershipTransitions.push(stateOwner);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "systemctl" && args[0] === "restart") {
          restartCount += 1;
          return restartCount === 1
            ? { code: 1, stdout: "", stderr: "forced restart failure" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const oldProcessCanReadState = () => stateOwner === "slnctrz";

      await expect(
        updateProduct(
          { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
          {
            stateRoot: f.stateRoot,
            fetch: f.fetch,
            run,
            serviceUnitRoot,
            isRoot: () => true,
            sleep: async () => undefined,
            releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
          }
        )
      ).rejects.toThrow("service_setup_failed: systemctl restart slnctrz-mcp.service");

      expect(ownershipTransitions).toEqual([userInfo().username, "slnctrz"]);
      expect(stateOwner).toBe("slnctrz");
      expect(oldProcessCanReadState()).toBe(true);
      expect(await readFile(unitFile, "utf8")).toBe(legacyUnit);
      expect(restartCount).toBe(2);
      expect(
        JSON.parse(await readFile(join(f.installRoot, "current.json"), "utf8")) as {
          version: string;
        }
      ).toMatchObject({ version: "1.0.0" });
    }
  );

  it.skipIf(process.platform !== "linux")(
    "restores the old activation when an effective systemd override blocks migration",
    async () => {
      const f = await fixture();
      const metadataFile = join(f.stateRoot, "installation.json");
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
      metadata.installMode = "system";
      metadata.serviceMode = "systemd";
      await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const serviceUnitRoot = await directory("slnctrz-management-dropin-");
      const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
      const legacyUnit = "[Service]\nUser=slnctrz\nGroup=slnctrz\nExecStart=/legacy/slnctrz-mcp\n";
      await writeFile(unitFile, legacyUnit, "utf8");
      const run = async (command: string, args: readonly string[]) => {
        if (command === "systemctl" && args[0] === "is-system-running")
          return { code: 0, stdout: "running\n", stderr: "" };
        if (command === "systemctl" && args.includes("--property=User"))
          return { code: 0, stdout: "slnctrz\n", stderr: "" };
        if (command === "systemctl" && args.includes("--property=Group"))
          return { code: 0, stdout: "slnctrz\n", stderr: "" };
        if (command === "systemctl" && args.includes("--property=MainPID"))
          return { code: 0, stdout: "8200\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };

      await expect(
        updateProduct(
          { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
          {
            stateRoot: f.stateRoot,
            fetch: f.fetch,
            run,
            serviceUnitRoot,
            isRoot: () => true,
            sleep: async () => undefined,
            releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
          }
        )
      ).rejects.toThrow("service_identity_overridden");

      expect(await readFile(unitFile, "utf8")).toBe(legacyUnit);
      expect(
        JSON.parse(await readFile(join(f.installRoot, "current.json"), "utf8")) as {
          version: string;
        }
      ).toMatchObject({ version: "1.0.0" });
    }
  );

  it.skipIf(process.platform !== "linux")(
    "migrates legacy System Install service identity across update, rollback, and repair",
    async () => {
      const f = await fixture();
      const metadataFile = join(f.stateRoot, "installation.json");
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
      metadata.installMode = "system";
      metadata.serviceMode = "systemd";
      await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const serviceUnitRoot = await directory("slnctrz-management-systemd-");
      const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
      await writeFile(
        unitFile,
        "[Service]\nUser=slnctrz\nGroup=slnctrz\nExecStart=/legacy/slnctrz-mcp\n",
        "utf8"
      );
      const calls: string[] = [];
      let mainPid = 7001;
      const effectiveUnitValue = async (key: "User" | "Group") => {
        const unit = await readFile(unitFile, "utf8");
        return new RegExp(`^${key}=([^\\r\\n]+)`, "m").exec(unit)?.[1] ?? "";
      };
      const run = async (command: string, args: readonly string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl" && args[0] === "is-system-running") {
          return { code: 0, stdout: "running\n", stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=User")) {
          return { code: 0, stdout: `${await effectiveUnitValue("User")}\n`, stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=Group")) {
          return { code: 0, stdout: `${await effectiveUnitValue("Group")}\n`, stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=MainPID")) {
          return { code: 0, stdout: `${mainPid}\n`, stderr: "" };
        }
        if (command === "systemctl" && args[0] === "restart") {
          mainPid += 1;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "ps") {
          return { code: 0, stdout: `${userInfo().uid} ${userInfo().gid}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const management = {
        stateRoot: f.stateRoot,
        fetch: f.fetch,
        run,
        serviceUnitRoot,
        isRoot: () => true,
        sleep: async () => undefined,
        releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
      };

      const unavailableRun = async (command: string, args: readonly string[]) =>
        command === "systemctl" && args[0] === "is-system-running"
          ? { code: 1, stdout: "offline\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" };
      await expect(
        updateProduct(
          { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
          { ...management, run: unavailableRun }
        )
      ).rejects.toThrow("service_manager_unavailable");
      expect(
        JSON.parse(await readFile(join(f.installRoot, "current.json"), "utf8")) as {
          version: string;
        }
      ).toMatchObject({ version: "1.0.0" });
      expect(await readFile(unitFile, "utf8")).toContain("User=slnctrz");

      const updated = await updateProduct(
        { manifestUrl: "https://updates.example.test/1.1.0/manifest.json" },
        management
      );

      expect(updated).toMatchObject({ activation: { version: "1.1.0" }, restartRequired: false });
      const unit = await readFile(unitFile, "utf8");
      expect(unit).toContain(`User=${userInfo().username}`);
      expect(unit).not.toContain("User=slnctrz");
      expect(calls).toContain("systemctl daemon-reload");
      expect(calls).toContain("systemctl restart slnctrz-mcp.service");
      expect(calls.some((call) => call.startsWith(`chown -R ${userInfo().username}:`))).toBe(true);

      calls.length = 0;
      await expect(rollbackProduct({ ...management, run: unavailableRun })).rejects.toThrow(
        "service_manager_unavailable"
      );
      expect(
        JSON.parse(await readFile(join(f.installRoot, "current.json"), "utf8")) as {
          version: string;
        }
      ).toMatchObject({ version: "1.1.0" });
      expect(await readFile(unitFile, "utf8")).toBe(unit);

      const rolled = await rollbackProduct(management);
      expect(rolled).toMatchObject({ activation: { version: "1.0.0" }, restartRequired: false });
      expect(await readFile(unitFile, "utf8")).toBe(unit);
      expect(calls).not.toContain("systemctl daemon-reload");
      expect(calls).toContain("systemctl restart slnctrz-mcp.service");

      await writeFile(
        unitFile,
        "[Service]\nUser=slnctrz\nGroup=slnctrz\nExecStart=/legacy/slnctrz-mcp\n",
        "utf8"
      );
      calls.length = 0;
      const repaired = await repairProduct(management);
      expect(repaired.changes).toContain("reconfigured_system_service_runtime_identity");
      expect(repaired.restartRequired).toBe(true);
      expect(await readFile(unitFile, "utf8")).toContain(`User=${userInfo().username}`);
      expect(calls).toContain("systemctl daemon-reload");
      expect(calls).not.toContain("systemctl restart slnctrz-mcp.service");
    }
  );

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

      const before = await runDoctor({
        stateRoot: f.stateRoot,
        fetch: f.fetch,
        releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
      });
      expect(before).toContainEqual(
        expect.objectContaining({ level: "FAIL", code: "state_root_permissions_unsafe" })
      );

      const repaired = await repairProduct({
        stateRoot: f.stateRoot,
        fetch: f.fetch,
        releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
      });
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
    const management = {
      stateRoot: f.stateRoot,
      fetch: f.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    };
    await rm(join(f.stateRoot, "command.json"));
    await rm(join(f.installRoot, userPlatformLayout().launcherFileName));
    await rm(join(f.stateRoot, "secrets", "owner-passphrase"));

    const result = await repairProduct(management);
    expect(result.changes).toContain("restored_launcher");
    expect(result.changes).toContain("restored_default_command_catalog");
    const repairedCatalog = JSON.parse(
      await readFile(join(f.stateRoot, "command.json"), "utf8")
    ) as {
      shell: { allowlist: { added: unknown[] } };
    };
    expect(repairedCatalog.shell.allowlist.added.length).toBeGreaterThan(0);
    await expect(access(join(f.stateRoot, "secrets", "owner-passphrase"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("preserves an existing valid-empty legacy catalog during repair", async () => {
    const f = await fixture();
    const emptyCatalog = `${JSON.stringify({ shell: { allowlist: { added: [] } } }, null, 2)}\n`;
    await writeFile(join(f.stateRoot, "command.json"), emptyCatalog, "utf8");

    const result = await repairProduct({
      stateRoot: f.stateRoot,
      fetch: f.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    });

    expect(result.changes).not.toContain("restored_default_command_catalog");
    expect(await readFile(join(f.stateRoot, "command.json"), "utf8")).toBe(emptyCatalog);
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
    const result = await uninstallProduct(
      {},
      { stateRoot: f.stateRoot, fetch: f.fetch, releaseTrustKeys: TEST_RELEASE_TRUST_KEYS }
    );
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
    const items = await runDoctor({
      stateRoot: f.stateRoot,
      fetch: f.fetch,
      releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
    });
    expect(items).toContainEqual(
      expect.objectContaining({ level: "FAIL", code: "installed_release_integrity_failed" })
    );
  });
});
