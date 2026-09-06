/** Linux system-service activation for a prepared System installation. */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApplicationRoot } from "../owner/managed-state.js";
import { readStandaloneTextAsset } from "./assets.js";
import type { InstallationMetadata } from "./installation-metadata.js";
import type { RuntimeIdentity } from "./runtime-identity.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<CommandResult>;

export interface SystemServiceSetup {
  readonly installation: InstallationMetadata;
  readonly gatewayConfigFile: string;
  readonly runtimeIdentity: RuntimeIdentity;
}

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

function safeSystemdToken(value: string, label: string): string {
  if (value.length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`runtime_identity_invalid: ${label} is unsafe for systemd`);
  }
  return value;
}

function systemdEnvironment(name: string, value: string): string {
  if (/[\u0000\r\n]/u.test(value)) {
    throw new Error(`runtime_identity_invalid: ${name} contains an unsafe character`);
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `Environment="${name}=${escaped}"`;
}

function renderUnit(template: string, setup: SystemServiceSetup): string {
  const runtimeUser = safeSystemdToken(setup.runtimeIdentity.username, "runtime user");
  const runtimeGroup = safeSystemdToken(setup.runtimeIdentity.groupName, "runtime group");
  const runtimePath = setup.runtimeIdentity.runtimePath;
  let rendered = template
    .replaceAll("/opt/slnctrz-mcp", setup.installation.installRoot)
    .replaceAll("/etc/slnctrz-mcp/gateway.env", setup.gatewayConfigFile)
    .replace("User=__SLNCTRZ_RUNTIME_USER__", `User=${runtimeUser}`)
    .replace("Group=__SLNCTRZ_RUNTIME_GROUP__", `Group=${runtimeGroup}`)
    .replace(
      'Environment="PATH=__SLNCTRZ_RUNTIME_PATH__"',
      systemdEnvironment("PATH", runtimePath)
    );
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
  setup: SystemServiceSetup,
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

export async function configureSystemService(
  setup: SystemServiceSetup,
  dependencies: SystemServiceDependencies = {}
): Promise<{ readonly unitFile: string; readonly serviceName: string; readonly changed: boolean }> {
  if (setup.installation.installMode !== "system") {
    throw new Error("System service configuration requires a system installation");
  }
  if (process.platform !== "linux") {
    throw new Error("System service configuration requires Linux");
  }
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

  const runtimeUser = setup.runtimeIdentity.username;
  const runtimeGroup = setup.runtimeIdentity.groupName;

  const pathAccess = await run("runuser", [
    "-u",
    runtimeUser,
    "--",
    "test",
    "-r",
    setup.installation.initialPath
  ]);
  if (pathAccess.code !== 0) {
    throw new Error(
      `path_os_permission_denied: runtime account ${runtimeUser} cannot read ${setup.installation.initialPath}`
    );
  }
  const pathWriteAccess = await run("runuser", [
    "-u",
    runtimeUser,
    "--",
    "test",
    "-w",
    setup.installation.initialPath
  ]);
  if (pathWriteAccess.code !== 0) {
    throw new Error(
      `path_os_permission_denied: runtime account ${runtimeUser} cannot write ${setup.installation.initialPath}`
    );
  }

  await requireSuccess(run, "chown", [
    "-R",
    `${runtimeUser}:${runtimeGroup}`,
    setup.installation.stateRoot
  ]);
  await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.installRoot]);
  await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.configRoot]);

  const serviceUnitRoot = dependencies.serviceUnitRoot ?? "/etc/systemd/system";
  await mkdir(serviceUnitRoot, { recursive: true, mode: 0o755 });
  const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
  const expectedUnit = renderUnit(await asset("config/systemd/slnctrz-mcp.service"), setup);
  const existingUnit = await readFile(unitFile, "utf8").catch(() => undefined);
  const changed = existingUnit !== expectedUnit;
  if (changed) {
    await atomicFile(unitFile, expectedUnit, 0o644);
    await requireSuccess(run, "systemctl", ["daemon-reload"]);
  }
  return { unitFile, serviceName: "slnctrz-mcp.service", changed };
}

export async function activateSystemService(
  setup: SystemServiceSetup,
  dependencies: SystemServiceDependencies = {}
): Promise<{ readonly unitFile: string; readonly serviceName: string }> {
  const configured = await configureSystemService(setup, dependencies);
  const run = dependencies.run ?? defaultRun;
  await requireSuccess(run, "systemctl", ["enable", "--now", configured.serviceName]);
  await waitForHealth(
    setup,
    dependencies.fetch ?? fetch,
    dependencies.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
  );
  return configured;
}
