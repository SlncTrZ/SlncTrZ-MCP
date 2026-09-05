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

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(value);
  return value;
}

function releaseFetch(bytes: Buffer): typeof fetch {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
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
  return (async (input) =>
    new Response(String(input).includes("manifest") ? manifest : bytes, {
      status: 200
    })) as typeof fetch;
}

describe("system service setup", () => {
  it.skipIf(process.platform !== "linux")(
    "creates the service account when absent, renders the unit, enables service, and health-checks",
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
        { fetch: releaseFetch(Buffer.from("system-release")), checkPort: async () => undefined }
      );

      const calls: string[] = [];
      const run: SystemCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "id") return { code: 1, stdout: "", stderr: "missing" };
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
      expect(calls.some((call) => call.startsWith("useradd "))).toBe(true);
      expect(calls).toContain("systemctl daemon-reload");
      expect(calls).toContain("systemctl enable --now slnctrz-mcp.service");
      expect(result.serviceName).toBe("slnctrz-mcp.service");
      const unit = await readFile(result.unitFile, "utf8");
      expect(unit).toContain(`WorkingDirectory=${setup.installation.installRoot}`);
      expect(unit).toContain(`EnvironmentFile=${setup.gatewayConfigFile}`);
      expect(unit).toContain(`ExecStart=${setup.installation.installRoot}/slnctrz-mcp-launcher`);
      expect(unit).not.toContain("/usr/bin/node");
      expect(unit).not.toContain("owner.env");
    }
  );

  it("fails before account/filesystem mutation when systemd is unavailable", async () => {
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
      { fetch: releaseFetch(Buffer.from("system-release")), checkPort: async () => undefined }
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
      { fetch: releaseFetch(Buffer.from("system-release")), checkPort: async () => undefined }
    );
    await expect(activateSystemService(setup, { isRoot: () => false })).rejects.toThrow(
      "permission_denied"
    );
  });
});
