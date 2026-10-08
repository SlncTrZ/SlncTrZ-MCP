/** Native artifact regression: uninstall legacy layouts and verify actual file removal. */
import { mkdtemp, mkdir, writeFile, copyFile, chmod, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const win = process.platform === "win32",
  target = win ? "win32-x64" : "linux-x64",
  file = win ? "slnctrz-mcp.exe" : "slnctrz-mcp";
const candidate = resolve("dist", "standalone", target, file);
const cases = [
  ["normal", "program", "state", "config"],
  ["nested state", "program", "program/data/state", "config"],
  ["nested config", "program", "state", "program/data/config"],
  ["both nested", "program", "program/data/state", "program/data/config"],
  ["shared roots", "shared", "shared", "shared"],
  ["program in state", "state/program", "state", "config"],
  ["state in config", "program", "config/state", "config"],
  ["config in state", "program", "state", "state/config"],
  ["quoted paths", "program space &'[x]", "state space", "config space"],
  ...(win
    ? [
        ["without shell PATH", "program", "state", "config", "system-path"],
        ["inside install cwd", "program", "state", "config", "install-cwd"],
        ["readonly managed files", "program", "state", "config", "readonly-files"]
      ]
    : [])
];
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
let count = 0;
for (const [name, program, state, config, environment] of cases)
  for (const mode of ["default", "remove-config", "purge"]) {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-fa4-artifact-"));
    try {
      const installRoot = join(root, program),
        stateRoot = join(root, state),
        configRoot = join(root, config),
        installationId = randomUUID();
      for (const p of [installRoot, stateRoot, configRoot]) await mkdir(p, { recursive: true });
      const metadata = {
        schemaVersion: 1,
        installationId,
        installMode: "user",
        installRoot,
        stateRoot,
        configRoot,
        serviceMode: "foreground",
        serviceName: "slnctrz-mcp",
        releaseChannel: "stable",
        host: "127.0.0.1",
        port: 3100,
        authorityMode: "restricted",
        initialPath: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeFile(join(stateRoot, "installation.json"), JSON.stringify(metadata));
      await writeFile(
        join(installRoot, "installation-marker.json"),
        JSON.stringify({ schemaVersion: 1, installationId, stateRoot })
      );
      await writeFile(join(installRoot, "current.json"), "{}");
      await mkdir(join(installRoot, "versions", "fixture"), { recursive: true });
      const executable = join(installRoot, "versions", "fixture", file);
      await copyFile(candidate, executable);
      if (!win) await chmod(executable, 0o755);
      const launcher = join(installRoot, win ? "slnctrz-mcp.exe" : "slnctrz-mcp-launcher");
      await writeFile(launcher, "fixture");
      await writeFile(join(stateRoot, "retained-state.txt"), "state");
      await writeFile(join(configRoot, "gateway.env"), "");
      await writeFile(join(configRoot, "client.env"), "");
      if (environment === "readonly-files") {
        for (const path of [
          launcher,
          join(stateRoot, "retained-state.txt"),
          join(configRoot, "gateway.env")
        ])
          await chmod(path, 0o400);
      }
      const run = spawnSync(
        executable,
        ["uninstall", "--yes", ...(mode === "default" ? [] : ["--" + mode])],
        {
          cwd: environment === "install-cwd" ? installRoot : root,
          env: {
            PATH:
              environment === "system-path"
                ? join(process.env.SystemRoot ?? process.env.WINDIR, "System32")
                : (process.env.PATH ?? ""),
            SystemRoot: process.env.SystemRoot ?? "",
            WINDIR: process.env.WINDIR ?? "",
            SLNCTRZ_STATE_ROOT: stateRoot
          },
          encoding: "utf8",
          timeout: 30000
        }
      );
      assert.equal(run.status, 0, name + " " + mode + ": " + run.stderr);
      if (win) assert.match(run.stdout, /Program removal deferred: yes/);
      const expectedRemoved = [
        executable,
        launcher,
        join(installRoot, "current.json"),
        ...(mode === "purge" ? [join(stateRoot, "retained-state.txt")] : []),
        ...(mode !== "default" ? [join(configRoot, "gateway.env")] : [])
      ];
      const until = Date.now() + 15000;
      let remaining = expectedRemoved;
      while (remaining.length > 0 && Date.now() < until) {
        remaining = (
          await Promise.all(
            expectedRemoved.map(async (path) => ((await exists(path)) ? path : undefined))
          )
        ).filter((path) => path !== undefined);
        if (remaining.length > 0) await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(remaining, [], name + " " + mode + ": removal incomplete");
      assert.equal(await exists(join(installRoot, "current.json")), false);
      assert.equal(await exists(launcher), false);
      assert.equal(await exists(join(stateRoot, "retained-state.txt")), mode !== "purge");
      assert.equal(await exists(join(configRoot, "gateway.env")), mode === "default");
      if (mode !== "purge")
        assert.equal(await readFile(join(stateRoot, "retained-state.txt"), "utf8"), "state");
      count++;
      console.log(name + " / " + mode + ": PASS");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
console.log(JSON.stringify({ status: "pass", target, cases: count, windowsSelfRemoval: win }));
