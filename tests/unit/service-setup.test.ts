import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentReleaseTarget } from "../../src/standalone/release-manifest.js";
import { prepareProductSetup } from "../../src/standalone/product-setup.js";
import {
  activateSystemService,
  type SystemCommandRunner
} from "../../src/standalone/service-setup.js";
import { TEST_RELEASE_TRUST_KEYS, signedManifestResponse } from "../helpers/release-signing.js";

const cleanup: string[] = [];
const runtimeIdentity = Object.freeze({
  username: "test-owner",
  uid: 1001,
  gid: 1001,
  groupName: "test-owner",
  home: "/home/test-owner",
  runtimePath: process.env.PATH ?? "/usr/bin"
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(value);
  return value;
}

function releaseFetch(bytes: Buffer, buildCommit?: string): typeof fetch {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    ...(buildCommit === undefined ? {} : { buildCommit }),
    artifacts: [
      {
        target: currentReleaseTarget(),
        url: "https://objects.example.test/slnctrz-mcp",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        fileName: process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
      }
    ]
  });
  return (async (input) => signedManifestResponse(input, manifest, bytes)) as typeof fetch;
}

const setupDependencies = (bytes: Buffer) => ({
  fetch: releaseFetch(bytes),
  checkPort: async () => undefined,
  resolveRuntimeIdentity: () => runtimeIdentity,
  verifyRuntimeBinary: () => true,
  releaseTrustKeys: TEST_RELEASE_TRUST_KEYS
});

describe("system service setup", () => {
  it.skipIf(process.platform !== "linux")(
    "uses the invoking runtime account, renders the unit, enables service, and health-checks",
    async () => {
      const root = await directory("slnctrz-system-setup-");
      const workspace = await directory("slnctrz-system-workspace-");
      const setup = await prepareProductSetup(
        {
          installMode: "system",
          port: 9130,
          initialPath: workspace,
          manifestUrl: "https://updates.example.test/manifest.json",
          installRoot: join(root, "install"),
          stateRoot: join(root, "state"),
          configRoot: join(root, "config")
        },
        setupDependencies(Buffer.from("system-release"))
      );

      const calls: string[] = [];
      let restarted = false;
      const run: SystemCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl" && args[0] === "restart") restarted = true;
        if (command === "systemctl" && args.includes("--property=User"))
          return { code: 0, stdout: `${runtimeIdentity.username}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=Group"))
          return { code: 0, stdout: `${runtimeIdentity.groupName}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=MainPID"))
          return { code: 0, stdout: restarted ? "222\n" : "111\n", stderr: "" };
        if (command === "ps")
          return { code: 0, stdout: `${runtimeIdentity.uid} ${runtimeIdentity.gid}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };
      const unitRoot = join(root, "systemd");
      const result = await activateSystemService(setup, {
        run,
        serviceUnitRoot: unitRoot,
        isRoot: () => true,
        fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
        sleep: async () => undefined
      });

      expect(calls[0]).toBe("systemctl is-system-running");
      expect(calls.some((call) => call.startsWith("useradd "))).toBe(false);
      expect(calls).toContain(`runuser -u ${runtimeIdentity.username} -- test -r ${workspace}`);
      expect(calls).toContain(`runuser -u ${runtimeIdentity.username} -- test -w ${workspace}`);
      expect(calls).toContain(
        `chown -R ${runtimeIdentity.username}:${runtimeIdentity.groupName} ${setup.installation.stateRoot}`
      );
      expect(calls).toContain("systemctl daemon-reload");
      expect(calls).toContain("systemctl enable slnctrz-mcp.service");
      expect(calls).toContain("systemctl restart slnctrz-mcp.service");
      expect(result.mainPid).toBe(222);
      expect(result.uid).toBe(runtimeIdentity.uid);
      expect(result.gid).toBe(runtimeIdentity.gid);
      expect(result.serviceName).toBe("slnctrz-mcp.service");
      const unit = await readFile(result.unitFile, "utf8");
      expect(unit).toContain(`User=${runtimeIdentity.username}`);
      expect(unit).toContain(`Group=${runtimeIdentity.groupName}`);
      expect(unit).toContain(`Environment=\"PATH=${runtimeIdentity.runtimePath}\"`);
      expect(unit).toContain(`WorkingDirectory=${setup.installation.installRoot}`);
      expect(unit).toContain(`EnvironmentFile=${setup.gatewayConfigFile}`);
      expect(unit).toContain(`ExecStart=${setup.installation.installRoot}/slnctrz-mcp-launcher`);
      expect(unit).not.toContain("/usr/bin/node");
      expect(unit).not.toContain("owner.env");
      expect(unit).not.toContain("User=slnctrz");
    }
  );

  it("fails before filesystem mutation when systemd is unavailable", async () => {
    if (process.platform !== "linux") return;
    const root = await directory("slnctrz-system-no-systemd-");
    const workspace = await directory("slnctrz-system-no-systemd-workspace-");
    const setup = await prepareProductSetup(
      {
        installMode: "system",
        initialPath: workspace,
        manifestUrl: "https://updates.example.test/manifest.json",
        installRoot: join(root, "install"),
        stateRoot: join(root, "state"),
        configRoot: join(root, "config")
      },
      setupDependencies(Buffer.from("system-release"))
    );
    const calls: string[] = [];
    const run: SystemCommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return command === "systemctl"
        ? { code: 1, stdout: "offline\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };

    await expect(activateSystemService(setup, { run, isRoot: () => true })).rejects.toThrow(
      "service_manager_unavailable"
    );
    expect(calls).toEqual(["systemctl is-system-running"]);
  });

  it("refuses system activation without root authority", async () => {
    if (process.platform !== "linux") return;
    const root = await directory("slnctrz-system-denied-");
    const workspace = await directory("slnctrz-system-denied-workspace-");
    const setup = await prepareProductSetup(
      {
        installMode: "system",
        initialPath: workspace,
        manifestUrl: "https://updates.example.test/manifest.json",
        installRoot: join(root, "install"),
        stateRoot: join(root, "state"),
        configRoot: join(root, "config")
      },
      setupDependencies(Buffer.from("system-release"))
    );
    await expect(activateSystemService(setup, { isRoot: () => false })).rejects.toThrow(
      "permission_denied"
    );
  });

  it.skipIf(process.platform !== "linux")(
    "restarts an already-active service before accepting health from the new runtime",
    async () => {
      const root = await directory("slnctrz-system-active-");
      const workspace = await directory("slnctrz-system-active-workspace-");
      const setup = await prepareProductSetup(
        {
          installMode: "system",
          port: 9131,
          initialPath: workspace,
          manifestUrl: "https://updates.example.test/manifest.json",
          installRoot: join(root, "install"),
          stateRoot: join(root, "state"),
          configRoot: join(root, "config")
        },
        setupDependencies(Buffer.from("system-release"))
      );
      let restarted = false;
      const calls: string[] = [];
      const run: SystemCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "systemctl" && args[0] === "restart") restarted = true;
        if (command === "systemctl" && args.includes("--property=User"))
          return { code: 0, stdout: `${runtimeIdentity.username}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=Group"))
          return { code: 0, stdout: `${runtimeIdentity.groupName}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=MainPID"))
          return { code: 0, stdout: restarted ? "444\n" : "333\n", stderr: "" };
        if (command === "ps")
          return { code: 0, stdout: `${runtimeIdentity.uid} ${runtimeIdentity.gid}\n`, stderr: "" };
        return {
          code: 0,
          stdout: command === "systemctl" && args[0] === "is-system-running" ? "running\n" : "",
          stderr: ""
        };
      };

      await activateSystemService(setup, {
        run,
        serviceUnitRoot: join(root, "systemd"),
        isRoot: () => true,
        fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
        sleep: async () => undefined
      });

      expect(restarted).toBe(true);
      expect(calls).toContain("systemctl restart slnctrz-mcp.service");
    }
  );

  it.skipIf(process.platform !== "linux")(
    "writes restart intent before restarting an already-active service",
    async () => {
      const root = await directory("slnctrz-system-intent-");
      const workspace = await directory("slnctrz-system-intent-workspace-");
      const setup = await prepareProductSetup(
        {
          installMode: "system",
          port: 9134,
          initialPath: workspace,
          manifestUrl: "https://updates.example.test/manifest.json",
          installRoot: join(root, "install"),
          stateRoot: join(root, "state"),
          configRoot: join(root, "config")
        },
        setupDependencies(Buffer.from("system-release"))
      );

      let restarted = false;
      let intentObservedAtRestart: Record<string, unknown> | undefined;
      const run: SystemCommandRunner = async (command, args) => {
        if (command === "systemctl" && args[0] === "restart") {
          intentObservedAtRestart = JSON.parse(
            await readFile(join(setup.installation.stateRoot, "lifecycle-intent.json"), "utf8")
          ) as Record<string, unknown>;
          restarted = true;
        }
        if (command === "systemctl" && args.includes("--property=User"))
          return { code: 0, stdout: `${runtimeIdentity.username}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=Group"))
          return { code: 0, stdout: `${runtimeIdentity.groupName}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=MainPID"))
          return { code: 0, stdout: restarted ? "778\n" : "777\n", stderr: "" };
        if (command === "ps")
          return { code: 0, stdout: `${runtimeIdentity.uid} ${runtimeIdentity.gid}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };

      await activateSystemService(
        { ...setup, lifecycleIntentReason: "release_restart" },
        {
          run,
          serviceUnitRoot: join(root, "systemd"),
          isRoot: () => true,
          fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
          sleep: async () => undefined
        }
      );

      expect(intentObservedAtRestart).toMatchObject({
        reason: "release_restart"
      });
      expect(typeof intentObservedAtRestart?.correlationId).toBe("string");
      expect(typeof intentObservedAtRestart?.createdAt).toBe("string");
      expect(typeof intentObservedAtRestart?.expiresAt).toBe("string");
    }
  );

  it.skipIf(process.platform !== "linux")(
    "attests a new PID, runtime UID/GID, version, and build before accepting activation",
    async () => {
      const root = await directory("slnctrz-system-attest-");
      const workspace = await directory("slnctrz-system-attest-workspace-");
      const bytes = Buffer.from("system-release-with-build");
      const buildCommit = "new-build-commit";
      const setup = await prepareProductSetup(
        {
          installMode: "system",
          port: 9133,
          initialPath: workspace,
          manifestUrl: "https://updates.example.test/manifest.json",
          installRoot: join(root, "install"),
          stateRoot: join(root, "state"),
          configRoot: join(root, "config")
        },
        {
          ...setupDependencies(bytes),
          fetch: releaseFetch(bytes, buildCommit)
        }
      );
      expect(setup.activation.buildCommit).toBe(buildCommit);

      let restarted = false;
      let healthObservedAfterRestartedPid = false;
      const run: SystemCommandRunner = async (command, args) => {
        if (command === "systemctl" && args[0] === "restart") restarted = true;
        if (command === "systemctl" && args.includes("--property=User"))
          return { code: 0, stdout: `${runtimeIdentity.username}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=Group"))
          return { code: 0, stdout: `${runtimeIdentity.groupName}\n`, stderr: "" };
        if (command === "systemctl" && args.includes("--property=MainPID"))
          return { code: 0, stdout: restarted ? "9022\n" : "9011\n", stderr: "" };
        if (command === "ps")
          return { code: 0, stdout: `${runtimeIdentity.uid} ${runtimeIdentity.gid}\n`, stderr: "" };
        return {
          code: 0,
          stdout: command === "systemctl" && args[0] === "is-system-running" ? "running\n" : "",
          stderr: ""
        };
      };
      const activationFetch = (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/healthz")) {
          healthObservedAfterRestartedPid = restarted;
          return new Response('{"status":"ok","source":"could-be-old"}', { status: 200 });
        }
        if (url.endsWith(":3101/status")) {
          const passphrase = (await readFile(setup.ownerPassphraseFile, "utf8")).trim();
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${passphrase}`);
          return new Response(JSON.stringify({ status: "ok", version: "1.2.3", buildCommit }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const result = await activateSystemService(setup, {
        run,
        serviceUnitRoot: join(root, "systemd"),
        isRoot: () => true,
        fetch: activationFetch,
        sleep: async () => undefined
      });

      expect(healthObservedAfterRestartedPid).toBe(true);
      expect(result).toMatchObject({
        mainPid: 9022,
        uid: runtimeIdentity.uid,
        gid: runtimeIdentity.gid,
        version: "1.2.3",
        buildCommit
      });
    }
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a systemd drop-in that overrides the requested runtime identity",
    async () => {
      const root = await directory("slnctrz-system-override-");
      const workspace = await directory("slnctrz-system-override-workspace-");
      const setup = await prepareProductSetup(
        {
          installMode: "system",
          port: 9132,
          initialPath: workspace,
          manifestUrl: "https://updates.example.test/manifest.json",
          installRoot: join(root, "install"),
          stateRoot: join(root, "state"),
          configRoot: join(root, "config")
        },
        setupDependencies(Buffer.from("system-release"))
      );
      const run: SystemCommandRunner = async (command, args) => {
        if (command === "systemctl" && args[0] === "is-system-running") {
          return { code: 0, stdout: "running\n", stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=User")) {
          return { code: 0, stdout: "slnctrz\n", stderr: "" };
        }
        if (command === "systemctl" && args.includes("--property=Group")) {
          return { code: 0, stdout: "slnctrz\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      await expect(
        activateSystemService(setup, {
          run,
          serviceUnitRoot: join(root, "systemd"),
          isRoot: () => true,
          fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
          sleep: async () => undefined
        })
      ).rejects.toThrow("service_identity_overridden");
    }
  );
});
