/** Linux system-service activation for a prepared System installation. */

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveApplicationRoot } from "../owner/managed-state.js";
import { readStandaloneTextAsset } from "./assets.js";
import {
  restoreStandaloneActivation,
  rollbackStandaloneRelease,
  type ActivationRecord
} from "./installer.js";
import type { InstallationMetadata } from "./installation-metadata.js";
import type { RuntimeIdentity } from "./runtime-identity.js";
import { readRuntimeEnvironmentFile } from "./runtime-env-file.js";

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
  readonly activation?: ActivationRecord;
  readonly rollbackActivation?: ActivationRecord;
  readonly ownerPassphraseFile?: string;
}

export interface SystemServiceDependencies {
  readonly run?: SystemCommandRunner;
  readonly fetch?: typeof fetch;
  readonly serviceUnitRoot?: string;
  readonly isRoot?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ServiceIdentity {
  readonly user: string;
  readonly group: string;
}

export interface SystemServicePreflight {
  readonly unitFile: string;
  readonly serviceName: string;
  readonly expectedUnit: string;
  readonly existingUnit?: string;
  readonly previousIdentity?: ServiceIdentity;
  readonly previousMainPid: number;
}

export interface SystemServiceConfiguration {
  readonly unitFile: string;
  readonly serviceName: string;
  readonly changed: boolean;
  readonly previousMainPid: number;
  rollback(): Promise<void>;
}

export interface SystemServiceActivation {
  readonly unitFile: string;
  readonly serviceName: string;
  readonly mainPid: number;
  readonly uid: number;
  readonly gid: number;
  readonly version?: string;
  readonly buildCommit?: string;
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

async function systemctlProperty(
  run: SystemCommandRunner,
  serviceName: string,
  property: string
): Promise<string | undefined> {
  const result = await run("systemctl", ["show", serviceName, `--property=${property}`, "--value"]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function effectiveServiceIdentity(
  run: SystemCommandRunner,
  serviceName: string
): Promise<ServiceIdentity | undefined> {
  const user = await systemctlProperty(run, serviceName, "User");
  if (user === undefined || user.length === 0) return undefined;
  let group = await systemctlProperty(run, serviceName, "Group");
  if (group === undefined || group.length === 0) {
    const resolved = await run("id", ["-gn", user]);
    if (resolved.code !== 0 || resolved.stdout.trim().length === 0) return undefined;
    group = resolved.stdout.trim();
  }
  return { user, group };
}

async function mainPid(run: SystemCommandRunner, serviceName: string): Promise<number> {
  const raw = await systemctlProperty(run, serviceName, "MainPID");
  const value = Number(raw ?? "0");
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function waitForProcessIdentity(
  setup: SystemServiceSetup,
  run: SystemCommandRunner,
  sleep: (ms: number) => Promise<void>,
  previousMainPid: number
): Promise<{ readonly pid: number; readonly uid: number; readonly gid: number }> {
  let last = "service has no main process";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pid = await mainPid(run, "slnctrz-mcp.service");
    if (pid > 0 && (previousMainPid === 0 || pid !== previousMainPid)) {
      const processIdentity = await run("ps", ["-o", "uid=", "-o", "gid=", "-p", String(pid)]);
      if (processIdentity.code === 0) {
        const [uidRaw, gidRaw] = processIdentity.stdout.trim().split(/\s+/u);
        const uid = Number(uidRaw);
        const gid = Number(gidRaw);
        if (Number.isSafeInteger(uid) && Number.isSafeInteger(gid)) {
          if (uid !== setup.runtimeIdentity.uid || gid !== setup.runtimeIdentity.gid) {
            throw new Error(
              `service_process_identity_mismatch: expected ${setup.runtimeIdentity.uid}:${setup.runtimeIdentity.gid}, got ${uid}:${gid}`
            );
          }
          return { pid, uid, gid };
        }
      }
      last = `could not read UID/GID for PID ${pid}`;
    } else if (pid === previousMainPid && pid > 0) {
      last = `service still has old PID ${pid}`;
    }
    await sleep(250);
  }
  throw new Error(`service_restart_not_observed: ${last}`);
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

async function waitForRunningRelease(
  setup: SystemServiceSetup,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<{ readonly version?: string; readonly buildCommit?: string }> {
  if (
    setup.activation === undefined ||
    setup.activation.buildCommit === undefined ||
    setup.ownerPassphraseFile === undefined
  )
    return {};
  const passphrase = (await readFile(setup.ownerPassphraseFile, "utf8")).replace(/\r?\n$/u, "");
  if (passphrase.length === 0)
    throw new Error("service_attestation_failed: owner passphrase is empty");
  const environment = await readRuntimeEnvironmentFile(setup.gatewayConfigFile);
  const controlHost = environment.SLNCTRZ_CONTROL_HOST ?? "127.0.0.1";
  const controlPort = Number(environment.SLNCTRZ_CONTROL_PORT ?? "3101");
  const address = controlHost === "::1" ? `[${controlHost}]` : controlHost;
  const url = `http://${address}:${controlPort}/status`;
  let last = "control status unavailable";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${passphrase}` }
      });
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const version = typeof body.version === "string" ? body.version : undefined;
        const buildCommit = typeof body.buildCommit === "string" ? body.buildCommit : undefined;
        if (version !== setup.activation.version) {
          last = `expected version ${setup.activation.version}, got ${version ?? "unknown"}`;
        } else if (
          setup.activation.buildCommit !== undefined &&
          buildCommit !== setup.activation.buildCommit
        ) {
          last = `expected build ${setup.activation.buildCommit}, got ${buildCommit ?? "unknown"}`;
        } else {
          return {
            ...(version === undefined ? {} : { version }),
            ...(buildCommit === undefined ? {} : { buildCommit })
          };
        }
      } else {
        last = `control status HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`service_attestation_failed: ${last}`);
}

async function restoreUnit(plan: SystemServicePreflight, run: SystemCommandRunner): Promise<void> {
  if (plan.existingUnit === undefined) await rm(plan.unitFile, { force: true });
  else await atomicFile(plan.unitFile, plan.existingUnit, 0o644);
  await requireSuccess(run, "systemctl", ["daemon-reload"]);
}

export async function preflightSystemService(
  setup: SystemServiceSetup,
  dependencies: SystemServiceDependencies = {}
): Promise<SystemServicePreflight> {
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

  const serviceUnitRoot = dependencies.serviceUnitRoot ?? "/etc/systemd/system";
  const unitFile = join(serviceUnitRoot, "slnctrz-mcp.service");
  const expectedUnit = renderUnit(await asset("config/systemd/slnctrz-mcp.service"), setup);
  const existingUnit = await readFile(unitFile, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const previousIdentity = await effectiveServiceIdentity(run, "slnctrz-mcp.service");
  return {
    unitFile,
    serviceName: "slnctrz-mcp.service",
    expectedUnit,
    ...(existingUnit === undefined ? {} : { existingUnit }),
    ...(previousIdentity === undefined ? {} : { previousIdentity }),
    previousMainPid: await mainPid(run, "slnctrz-mcp.service")
  };
}

export async function configureSystemService(
  setup: SystemServiceSetup,
  dependencies: SystemServiceDependencies = {}
): Promise<SystemServiceConfiguration> {
  const run = dependencies.run ?? defaultRun;
  const plan = await preflightSystemService(setup, dependencies);
  const stateOwner = await stat(setup.installation.stateRoot);
  const restoreStateOwner =
    plan.previousIdentity === undefined
      ? `${stateOwner.uid}:${stateOwner.gid}`
      : `${plan.previousIdentity.user}:${plan.previousIdentity.group}`;
  const changed = plan.existingUnit !== plan.expectedUnit;
  let unitMutated = false;
  let stateMutated = false;

  const rollback = async (): Promise<void> => {
    const failures: unknown[] = [];
    if (stateMutated) {
      try {
        await requireSuccess(run, "chown", ["-R", restoreStateOwner, setup.installation.stateRoot]);
        stateMutated = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (unitMutated) {
      try {
        await restoreUnit(plan, run);
        unitMutated = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new Error("service_configuration_rollback_failed");
  };

  try {
    await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.installRoot]);
    await requireSuccess(run, "chown", ["-R", "root:root", setup.installation.configRoot]);

    if (changed) {
      await mkdir(dirname(plan.unitFile), { recursive: true, mode: 0o755 });
      await atomicFile(plan.unitFile, plan.expectedUnit, 0o644);
      unitMutated = true;
      await requireSuccess(run, "systemctl", ["daemon-reload"]);
    }

    const effective = await effectiveServiceIdentity(run, plan.serviceName);
    if (
      effective === undefined ||
      effective.user !== setup.runtimeIdentity.username ||
      effective.group !== setup.runtimeIdentity.groupName
    ) {
      throw new Error(
        `service_identity_overridden: expected ${setup.runtimeIdentity.username}:${setup.runtimeIdentity.groupName}, got ${effective?.user ?? "unknown"}:${effective?.group ?? "unknown"}`
      );
    }

    stateMutated = true;
    await requireSuccess(run, "chown", [
      "-R",
      `${setup.runtimeIdentity.username}:${setup.runtimeIdentity.groupName}`,
      setup.installation.stateRoot
    ]);
  } catch (error) {
    try {
      await rollback();
    } catch {
      throw new Error(
        `service_configuration_rollback_failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }

  return {
    unitFile: plan.unitFile,
    serviceName: plan.serviceName,
    changed,
    previousMainPid: plan.previousMainPid,
    rollback
  };
}

async function restoreActivationAfterFailure(setup: SystemServiceSetup): Promise<void> {
  if (setup.rollbackActivation !== undefined) {
    await restoreStandaloneActivation(setup.installation.installRoot, setup.rollbackActivation);
    return;
  }
  if (setup.activation?.previousVersion !== undefined) {
    await rollbackStandaloneRelease({ installRoot: setup.installation.installRoot });
  }
}

export async function activateSystemService(
  setup: SystemServiceSetup,
  dependencies: SystemServiceDependencies = {}
): Promise<SystemServiceActivation> {
  const run = dependencies.run ?? defaultRun;
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  let configured: SystemServiceConfiguration;
  try {
    configured = await configureSystemService(setup, dependencies);
  } catch (error) {
    try {
      await restoreActivationAfterFailure(setup);
    } catch {
      throw new Error(
        `service_activation_rollback_failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
  try {
    await requireSuccess(run, "systemctl", ["enable", configured.serviceName]);
    await requireSuccess(run, "systemctl", ["restart", configured.serviceName]);
    const processIdentity = await waitForProcessIdentity(
      setup,
      run,
      sleep,
      configured.previousMainPid
    );
    await waitForHealth(setup, dependencies.fetch ?? fetch, sleep);
    const running = await waitForRunningRelease(setup, dependencies.fetch ?? fetch, sleep);
    return {
      unitFile: configured.unitFile,
      serviceName: configured.serviceName,
      mainPid: processIdentity.pid,
      uid: processIdentity.uid,
      gid: processIdentity.gid,
      ...running
    };
  } catch (error) {
    const failures: unknown[] = [];
    try {
      await restoreActivationAfterFailure(setup);
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    try {
      await configured.rollback();
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    if (configured.previousMainPid > 0) {
      try {
        await requireSuccess(run, "systemctl", ["restart", configured.serviceName]);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `service_activation_rollback_failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
}
