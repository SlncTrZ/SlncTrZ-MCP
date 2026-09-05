/** Linux system-service activation for a prepared System installation. */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProductSetupResult } from "./product-setup.js";
import { resolveApplicationRoot } from "../owner/managed-state.js";
import { readStandaloneTextAsset } from "./assets.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<CommandResult>;

export interface SystemServiceDependencies {
  readonly run?: SystemCommandRunner;
  readonly fetch?: typeof fetch;
  readonly serviceUnitRoot?: string;
  readonly isRoot?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function defaultRun(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
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

async function asset(key: string): Promise<string> {
  const embedded = readStandaloneTextAsset(key);
  if (embedded !== undefined) return embedded;
  return readFile(join(resolveApplicationRoot(), key), "utf8");
}

async function atomicFile(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return new Error(`service_setup_failed: ${command}: ${detail}`);
}

function renderUnit(template: string, setup: ProductSetupResult): string {
  let rendered = template
    .replaceAll("/opt/slnctrz-mcp", setup.installation.installRoot)
    .replaceAll("/etc/slnctrz-mcp/gateway.env", setup.gatewayConfigFile);
  if (setup.installation.stateRoot !== "/var/lib/slnctrz-mcp") {
    rendered = rendered.replace(
      "StateDirectory=slnctrz-mcp",
      `# State directory managed by setup: ${setup.installation.stateRoot}`
    );
  }
  return rendered;
}

async function requireSuccess(
  run: SystemCommandRunner,
  command: string,
  args: readonly string[]
): Promise<CommandResult> {
  const result = await run(command, args);
  if (result.code !== 0) throw commandFailure(`${command} ${args.join(" ")}`, result);
  return result;
}

async function waitForHealth(
  setup: ProductSetupResult,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const url = `http://127.0.0.1:${setup.installation.port}/healthz`;
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return;
      last = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(
    `health_check_failed: ${last instanceof Error ? last.message : "gateway did not become healthy"}`
  );
}

export async function activateSystemService(
  setup: ProductSetupResult,
  dependencies: SystemServiceDependencies = {}
): Promise<{ readonly unitFile: string; readonly serviceName: string }> {
  if (setup.installation.installMode !== "system") {
    throw new Error("System service activation requires a system installation");
  }
  if (process.platform !== "linux") throw new Error("System service activation requires Linux");
  const isRoot = dependencies.isRoot ?? (() => process.getuid?.() === 0);
  if (!isRoot()) throw new Error("permission_denied: system setup must run as root/sudo");

  const run = dependencies.run ?? defaultRun;
  let serviceManager: CommandResult;
  try {
    serviceManager = await run("systemctl", ["is-system-running"]);
  } catch (error) {
    throw new Error(
      `service_manager_unavailable: ${error instanceof Error ? error.message : "systemctl could not be started"}`
    );
  }
  const managerState = serviceManager.stdout.trim();
  if (serviceManager.code !== 0 && managerState !== "degraded") {
    throw new Error(
      `service_manager_unavailable: systemd is not operational (${managerState || serviceManager.stderr.trim() || `exit ${serviceManager.code}`})`
    );
  }

  const existingUser = await run("id", ["-u", "slnctrz"]);
  if (existingUser.code !== 0) {
    await requireSuccess(run, "useradd", [
      "--system",
      "--home-dir",
      setup.installation.stateRoot,
      "--shell",
      "/usr/sbin/nologin",
      "slnctrz"
    ]);
  }

  const pathAccess = await run("runuser", [
    "-u",
    "slnctrz",
    "--",
    "test",
    "-r",
    setup.installation.initialPath
  ]);
  if (pathAccess.code !== 0) {
    throw new Error(
      `path_os_permission_denied: runtime account slnctrz cannot read ${setup.installation.initialPath}`
    );
  }

  await requireSuccess(run, "chown", ["-R", "slnctrz:slnctrz", setup.installation.stateRoot]);
  await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.installRoot]);
  await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.configRoot]);

  const serviceUnitRoot = dependencies.serviceUnitRoot ?? "/etc/systemd/system";
  await mkdir(serviceUnitRoot, { recursive: true, mode: 0o755 });
  const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
  await atomicFile(
    unitFile,
    renderUnit(await asset("config/systemd/slnctrz-mcp.service"), setup),
    0o644
  );

  await requireSuccess(run, "systemctl", ["daemon-reload"]);
  await requireSuccess(run, "systemctl", ["enable", "--now", "slnctrz-mcp.service"]);
  await waitForHealth(
    setup,
    dependencies.fetch ?? fetch,
    dependencies.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
  );
  return { unitFile, serviceName: "slnctrz-mcp.service" };
}
