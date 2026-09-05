import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
  });
}

describe("standalone launcher config allowlist", () => {
  it.skipIf(process.platform === "win32")(
    "accepts all supported non-secret runtime keys and rejects unknown keys",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-launcher-"));
      cleanup.push(root);
      const versionDir = join(root, "versions", "1.2.3");
      await mkdir(versionDir, { recursive: true, mode: 0o755 });

      const executable = join(versionDir, "slnctrz-mcp");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `printf '%s|%s|%s|%s|%s|%s\\n' "$SLNCTRZ_MAX_DYNAMIC_CLIENTS" "$SLNCTRZ_CONTROL_PORT" "$SLNCTRZ_TELEMETRY_ENABLED" "$SLNCTRZ_ALLOWED_HOSTS" "$SLNCTRZ_ALLOWED_ORIGINS" "$SLNCTRZ_POLICY_FILE"`
        ].join("\n"),
        "utf8"
      );
      await chmod(executable, 0o755);
      await writeFile(
        join(root, "current.json"),
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.3",
          fileName: "slnctrz-mcp",
          sha256: "0".repeat(64),
          sizeBytes: 1,
          activatedAt: new Date(0).toISOString()
        }),
        "utf8"
      );

      const config = join(root, "gateway.env");
      await writeFile(
        config,
        [
          "SLNCTRZ_HOST=127.0.0.1",
          "SLNCTRZ_PORT=3100",
          "SLNCTRZ_OWNER_WEB_ENABLED=true",
          "SLNCTRZ_MAX_DYNAMIC_CLIENTS=2048",
          "SLNCTRZ_CONTROL_HOST=127.0.0.1",
          "SLNCTRZ_CONTROL_PORT=3999",
          "SLNCTRZ_TELEMETRY_ENABLED=false",
          "SLNCTRZ_ALLOWED_HOSTS=localhost,127.0.0.1",
          "SLNCTRZ_ALLOWED_ORIGINS=localhost,127.0.0.1",
          "SLNCTRZ_STATE_ROOT=/tmp/slnctrz-state",
          "SLNCTRZ_POLICY_FILE=/tmp/slnctrz-state/policy.json",
          ""
        ].join("\n"),
        "utf8"
      );

      const accepted = await run("sh", ["config/systemd/slnctrz-mcp-launcher.sh"], {
        PATH: process.env.PATH,
        SLNCTRZ_INSTALL_ROOT: root,
        SLNCTRZ_CONFIG_FILE: config
      });
      expect(accepted.code).toBe(0);
      expect(accepted.stdout.trim()).toBe(
        "2048|3999|false|localhost,127.0.0.1|localhost,127.0.0.1|/tmp/slnctrz-state/policy.json"
      );

      await writeFile(config, "SLNCTRZ_UNKNOWN=value\n", "utf8");
      const rejected = await run("sh", ["config/systemd/slnctrz-mcp-launcher.sh"], {
        PATH: process.env.PATH,
        SLNCTRZ_INSTALL_ROOT: root,
        SLNCTRZ_CONFIG_FILE: config
      });
      expect(rejected.code).toBe(70);
      expect(rejected.stderr).toContain("unsupported config key");
    }
  );
});
