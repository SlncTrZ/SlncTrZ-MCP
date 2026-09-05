/** Installed product status, diagnostics, configuration, update, recovery and uninstall. */

import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readRuntimeConfig } from "../app/config.js";
import { compileCommandCatalog, parseCommandAllowlist } from "../kernel/command-catalog.js";
import { loadPolicyDocument } from "../policy/policy-config.js";
import {
  ensureManagedStateLayout,
  managedStatePaths,
  resolveApplicationRoot,
  type ManagedStatePaths
} from "../owner/managed-state.js";
import { createMcpProviderStore } from "../owner/mcp-provider-store.js";
import { DEFAULT_MAX_PERSISTED_AUDIT_ROWS } from "../observability/sqlite-audit.js";
import { readStandaloneTextAsset } from "./assets.js";
import { fetchReleaseManifest } from "./manifest-fetch.js";
import {
  installStandaloneRelease,
  resolveCurrentStandaloneExecutable,
  rollbackStandaloneRelease,
  verifyCurrentStandaloneIntegrity,
  type ActivationRecord
} from "./installer.js";
import {
  readInstallationMetadata,
  writeInstallationMetadata,
  type InstallationMetadata
} from "./installation-metadata.js";
import { OFFICIAL_RELEASE_MANIFEST_URL } from "./product-setup.js";
import { userPlatformLayout } from "./platform-layout.js";
import { currentReleaseTarget } from "./release-manifest.js";
import { readRuntimeEnvironmentFile } from "./runtime-env-file.js";

export type DiagnosticLevel = "PASS" | "WARN" | "FAIL" | "INFO";

export interface DiagnosticItem {
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
  readonly action?: string;
}

export interface InstalledProductContext {
  readonly installation: InstallationMetadata;
  readonly statePaths: ManagedStatePaths;
}

export interface ProductStatus {
  readonly version: string;
  readonly buildCommit: string;
  readonly runningVersion?: string;
  readonly runningBuildCommit?: string;
  readonly versionMismatch: boolean;
  readonly installMode: InstallationMetadata["installMode"];
  readonly serviceMode: InstallationMetadata["serviceMode"];
  readonly installRoot: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly authorityMode: "restricted" | "autonomous";
  readonly paths: readonly string[];
  readonly commands: number;
  readonly mcpServers: number;
  readonly mcpServersEnabled: number;
  readonly installedIntegrity: "ok" | "failed";
  readonly gateway: "running" | "unreachable";
  readonly mcpEndpoint: string;
  readonly ownerConsoleUrl: string;
  readonly ownerPassphraseFile: string;
}

export interface ManagementDependencies {
  readonly fetch?: typeof fetch;
  readonly stateRoot?: string;
  readonly run?: (
    command: string,
    args: readonly string[]
  ) => Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly serviceUnitRoot?: string;
}

async function defaultRun(
  command: string,
  args: readonly string[]
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export async function discoverInstalledProduct(
  dependencies: Pick<ManagementDependencies, "stateRoot"> = {}
): Promise<InstalledProductContext> {
  const candidates = unique([
    ...(dependencies.stateRoot === undefined ? [] : [dependencies.stateRoot]),
    managedStatePaths().root,
    ...(process.platform === "linux" ? ["/var/lib/slnctrz-mcp"] : [])
  ]);
  for (const root of candidates) {
    if (!isAbsolute(root)) continue;
    const paths = managedStatePaths(root);
    const installation = await readInstallationMetadata(paths.installationMetadataFile).catch(
      () => undefined
    );
    if (installation !== undefined) return { installation, statePaths: paths };
  }
  throw new Error(
    `installation_not_found: no SlncTrZ installation metadata found under ${candidates.join(", ")}`
  );
}

function appendCsvValue(raw: string | undefined, value: string): string | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!entries.some((entry) => entry.toLowerCase() === value.toLowerCase())) entries.push(value);
  return entries.join(",");
}

function gatewayEnvironmentText(environment: NodeJS.ProcessEnv): string {
  const order = [
    "SLNCTRZ_HOST",
    "SLNCTRZ_PORT",
    "SLNCTRZ_PUBLIC_URL",
    "SLNCTRZ_OWNER_WEB_ENABLED",
    "SLNCTRZ_MAX_DYNAMIC_CLIENTS",
    "SLNCTRZ_CONTROL_HOST",
    "SLNCTRZ_CONTROL_PORT",
    "SLNCTRZ_TELEMETRY_ENABLED",
    "SLNCTRZ_ALLOWED_HOSTS",
    "SLNCTRZ_ALLOWED_ORIGINS",
    "SLNCTRZ_STATE_ROOT",
    "SLNCTRZ_POLICY_FILE"
  ];
  return `${order
    .filter((key) => environment[key] !== undefined)
    .map((key) => {
      const value = environment[key] ?? "";
      if (/[\r\n]/u.test(value)) throw new Error(`${key} contains a line break`);
      return `${key}=${value}`;
    })
    .join("\n")}\n`;
}

async function atomicText(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function productAsset(key: string): Promise<string> {
  const embedded = readStandaloneTextAsset(key);
  if (embedded !== undefined) return embedded;
  return readFile(join(resolveApplicationRoot(), key), "utf8");
}

interface RunningIdentity {
  readonly version: string;
  readonly buildCommit: string;
  readonly authorityMode?: "restricted" | "autonomous";
}

async function runningIdentity(
  context: InstalledProductContext,
  fetchImpl: typeof fetch,
  controlHost: "127.0.0.1" | "::1",
  controlPort: number
): Promise<RunningIdentity | undefined> {
  let passphrase: string;
  try {
    passphrase = (await readFile(context.statePaths.ownerPassphraseFile, "utf8")).replace(
      /\r?\n$/u,
      ""
    );
  } catch {
    return undefined;
  }
  if (passphrase.length === 0) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  timer.unref();
  try {
    const controlAddress = controlHost === "::1" ? `[${controlHost}]` : controlHost;
    const response = await fetchImpl(`http://${controlAddress}:${controlPort}/status`, {
      headers: { authorization: `Bearer ${passphrase}` },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    if (typeof record.version !== "string" || typeof record.buildCommit !== "string") {
      return undefined;
    }
    const authorityMode =
      record.authorityMode === "restricted" || record.authorityMode === "autonomous"
        ? record.authorityMode
        : undefined;
    return {
      version: record.version,
      buildCommit: record.buildCommit,
      ...(authorityMode === undefined ? {} : { authorityMode })
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayReachable(
  installation: InstallationMetadata,
  fetchImpl: typeof fetch
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  timer.unref();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${installation.port}/healthz`, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function restartSystemService(
  context: InstalledProductContext,
  dependencies: ManagementDependencies
): Promise<void> {
  if (context.installation.installMode !== "system") return;
  const run = dependencies.run ?? defaultRun;
  const result = await run("systemctl", ["restart", "slnctrz-mcp.service"]);
  if (result.code !== 0) {
    throw new Error(
      `service_restart_failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`
    );
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await gatewayReachable(context.installation, fetchImpl)) return;
    await sleep(250);
  }
  throw new Error("health_check_failed: gateway did not become healthy after service restart");
}

async function loadPolicyState(context: InstalledProductContext) {
  return loadPolicyDocument(context.statePaths.policyFile);
}

async function countCommands(context: InstalledProductContext): Promise<number> {
  const raw = JSON.parse(await readFile(context.statePaths.commandCatalogFile, "utf8")) as unknown;
  const entries = parseCommandAllowlist(raw);
  compileCommandCatalog(entries);
  return entries.length;
}

async function providerCounts(
  context: InstalledProductContext
): Promise<{ readonly total: number; readonly enabled: number }> {
  const providers = await createMcpProviderStore(context.statePaths.mcpProvidersFile).list();
  return {
    total: providers.length,
    enabled: providers.filter((provider) => provider.enabled).length
  };
}

export async function readProductStatus(
  dependencies: ManagementDependencies = {}
): Promise<ProductStatus> {
  const context = await discoverInstalledProduct(dependencies);
  const policy = await loadPolicyState(context);
  const fetchImpl = dependencies.fetch ?? fetch;
  const environment = await readRuntimeEnvironmentFile(
    join(context.installation.configRoot, "gateway.env")
  );
  const runtime = readRuntimeConfig(environment);
  const [commands, providers, integrityRecord, running, identity] = await Promise.all([
    countCommands(context),
    providerCounts(context),
    verifyCurrentStandaloneIntegrity(context.installation.installRoot).catch(() => undefined),
    gatewayReachable(context.installation, fetchImpl),
    runningIdentity(context, fetchImpl, runtime.controlHost, runtime.controlPort)
  ]);
  const installedVersion = integrityRecord?.activation.version ?? "unknown";
  const versionMismatch =
    identity !== undefined &&
    installedVersion !== "unknown" &&
    identity.version !== installedVersion;
  return {
    version: installedVersion,
    buildCommit: identity?.buildCommit ?? process.env.SLNCTRZ_BUILD_COMMIT ?? "unknown",
    ...(identity === undefined
      ? {}
      : { runningVersion: identity.version, runningBuildCommit: identity.buildCommit }),
    versionMismatch,
    installMode: context.installation.installMode,
    serviceMode: context.installation.serviceMode,
    installRoot: context.installation.installRoot,
    stateRoot: context.installation.stateRoot,
    configRoot: context.installation.configRoot,
    authorityMode: policy.authorityMode ?? "restricted",
    paths: [...policy.paths],
    commands,
    mcpServers: providers.total,
    mcpServersEnabled: providers.enabled,
    installedIntegrity: integrityRecord === undefined ? "failed" : "ok",
    gateway: running ? "running" : "unreachable",
    mcpEndpoint: runtime.publicMcpUrl.href,
    ownerConsoleUrl: `${runtime.publicMcpUrl.origin}/owner`,
    ownerPassphraseFile: context.statePaths.ownerPassphraseFile
  };
}

function diagnostic(
  level: DiagnosticLevel,
  code: string,
  message: string,
  action?: string
): DiagnosticItem {
  return {
    level,
    code,
    message,
    ...(action === undefined ? {} : { action })
  };
}

export async function runDoctor(
  dependencies: ManagementDependencies = {}
): Promise<readonly DiagnosticItem[]> {
  const items: DiagnosticItem[] = [];
  let context: InstalledProductContext;
  try {
    context = await discoverInstalledProduct(dependencies);
    items.push(
      diagnostic("PASS", "installation_metadata_valid", "Installation metadata is valid.")
    );
  } catch (error) {
    return [
      diagnostic(
        "FAIL",
        "installation_metadata_missing",
        error instanceof Error ? error.message : "Installation metadata is unavailable.",
        "Run slnctrz-mcp setup or restore installation.json."
      )
    ];
  }

  try {
    const integrity = await verifyCurrentStandaloneIntegrity(context.installation.installRoot);
    items.push(
      diagnostic(
        "PASS",
        "installed_release_integrity_ok",
        `Installed release ${integrity.activation.version} matches size and SHA-256 metadata.`
      )
    );
    const marker = await readInstallMarker(context.installation.installRoot);
    if (
      marker.installationId !== context.installation.installationId ||
      resolve(marker.stateRoot) !== resolve(context.installation.stateRoot)
    ) {
      throw new Error("installation identity marker does not match managed state");
    }
    items.push(
      diagnostic(
        "PASS",
        "installation_identity_match",
        "Install-root and state identity markers match."
      )
    );
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "installed_release_integrity_failed",
        error instanceof Error ? error.message : "Installed release integrity failed.",
        "Run slnctrz-mcp repair or rollback to a verified release."
      )
    );
  }

  try {
    const policy = await loadPolicyState(context);
    items.push(
      diagnostic(
        "PASS",
        "policy_valid",
        `Policy is valid: ${policy.paths.length} Path(s), authority ${policy.authorityMode ?? "restricted"}.`
      )
    );
    for (const path of policy.paths) {
      try {
        const canonical = await realpath(path);
        await access(canonical, constants.R_OK);
        items.push(diagnostic("PASS", "path_readable", `Path readable: ${canonical}`));
      } catch {
        items.push(
          diagnostic(
            "FAIL",
            "path_os_permission_denied",
            `Configured Path is missing or unreadable: ${path}`,
            "Fix OS permissions or remove the Path in Owner Console."
          )
        );
      }
    }
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "policy_invalid",
        error instanceof Error ? error.message : "Policy is invalid.",
        "Restore a valid policy backup; doctor will not overwrite it."
      )
    );
  }

  try {
    const commands = await countCommands(context);
    items.push(
      diagnostic("PASS", "command_catalog_valid", `Command catalog valid: ${commands} rule(s).`)
    );
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "command_catalog_invalid",
        error instanceof Error ? error.message : "Command catalog is invalid.",
        "Use repair only if the catalog is missing; invalid existing content is preserved."
      )
    );
  }

  for (const [code, label, path] of [
    ["state_root_permissions", "State root", context.statePaths.root],
    ["mcp_state_permissions", "MCP state directory", context.statePaths.mcpDirectory],
    [
      "mcp_credentials_permissions",
      "MCP credentials directory",
      context.statePaths.mcpCredentialsDirectory
    ],
    ["secrets_directory_permissions", "Secrets directory", context.statePaths.secretsDirectory]
  ] as const) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label} is not a plain directory`);
      }
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        items.push(
          diagnostic(
            "FAIL",
            `${code}_unsafe`,
            `${label} is accessible to group/other users: ${path}`,
            "Run slnctrz-mcp repair to reassert the managed-state private directory modes."
          )
        );
      } else {
        items.push(diagnostic("PASS", `${code}_ok`, `${label} is private: ${path}`));
      }
    } catch (error) {
      items.push(
        diagnostic(
          "FAIL",
          `${code}_invalid`,
          error instanceof Error ? error.message : `${label} could not be inspected.`,
          "Restore the managed-state layout before starting the gateway."
        )
      );
    }
  }

  try {
    const info = await lstat(context.statePaths.ownerPassphraseFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("owner passphrase path is unsafe");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      items.push(
        diagnostic(
          "FAIL",
          "owner_secret_permissions_unsafe",
          "Owner Passphrase is readable by group/other users.",
          "Run slnctrz-mcp repair to restore private mode."
        )
      );
    } else {
      items.push(
        diagnostic(
          "PASS",
          "owner_secret_present",
          `Owner Passphrase recovery file is present at ${context.statePaths.ownerPassphraseFile}.`
        )
      );
    }
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "owner_secret_missing",
        error instanceof Error ? error.message : "Owner Passphrase recovery file is unavailable.",
        "Restore the recovery file from backup; do not silently regenerate an existing installation credential."
      )
    );
  }

  try {
    const providers = await providerCounts(context);
    items.push(
      diagnostic(
        "PASS",
        "provider_store_valid",
        `MCP provider store valid: ${providers.enabled}/${providers.total} enabled.`
      )
    );
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "provider_store_invalid",
        error instanceof Error ? error.message : "MCP provider store is invalid.",
        "Inspect providers.json; doctor will not delete provider configuration."
      )
    );
  }

  try {
    const info = await lstat(context.statePaths.auditDatabaseFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Audit database path is unsafe");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      items.push(
        diagnostic(
          "FAIL",
          "audit_store_permissions_unsafe",
          "Audit database is accessible to group/other users.",
          "Restrict the audit database to the gateway account before continuing."
        )
      );
    } else {
      items.push(
        diagnostic(
          "PASS",
          "audit_store_present",
          `Audit database is present (${Math.ceil(info.size / 1024)} KiB); persisted retention is bounded to ${DEFAULT_MAX_PERSISTED_AUDIT_ROWS.toLocaleString("en-US")} rows by default.`
        )
      );
    }
  } catch {
    items.push(
      diagnostic(
        "WARN",
        "audit_store_missing",
        "Audit database is not present yet.",
        "Start the gateway once; investigate if audit initialization continues to fail."
      )
    );
  }

  try {
    const fs = await statfs(context.installation.installRoot);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    items.push(
      diagnostic(
        freeBytes < 256 * 1024 * 1024 ? "WARN" : "PASS",
        freeBytes < 256 * 1024 * 1024 ? "disk_space_low" : "disk_space_ok",
        `Free space near install root: ${Math.floor(freeBytes / (1024 * 1024))} MiB.`,
        freeBytes < 256 * 1024 * 1024 ? "Free disk space before updating." : undefined
      )
    );
  } catch {
    items.push(diagnostic("INFO", "disk_space_unknown", "Disk free-space check is unavailable."));
  }

  try {
    const environment = await readRuntimeEnvironmentFile(
      join(context.installation.configRoot, "gateway.env")
    );
    const runtime = readRuntimeConfig(environment);
    items.push(
      diagnostic(
        "PASS",
        "runtime_config_valid",
        `Runtime config valid: ${runtime.host}:${runtime.port} -> ${runtime.publicMcpUrl.href}`
      )
    );
  } catch (error) {
    items.push(
      diagnostic(
        "FAIL",
        "runtime_config_invalid",
        error instanceof Error ? error.message : "Runtime configuration is invalid.",
        "Use slnctrz-mcp config show and a validated config set command."
      )
    );
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const running = await gatewayReachable(context.installation, fetchImpl);
  items.push(
    diagnostic(
      running ? "PASS" : context.installation.serviceMode === "systemd" ? "FAIL" : "WARN",
      running ? "gateway_reachable" : "gateway_unreachable",
      running
        ? "Gateway health endpoint is reachable."
        : "Gateway health endpoint is not reachable.",
      running ? undefined : "Start/restart the gateway, then rerun doctor."
    )
  );

  if (running) {
    let identityRuntime: ReturnType<typeof readRuntimeConfig> | undefined;
    try {
      identityRuntime = readRuntimeConfig(
        await readRuntimeEnvironmentFile(join(context.installation.configRoot, "gateway.env"))
      );
    } catch {
      identityRuntime = undefined;
    }
    const identity =
      identityRuntime === undefined
        ? undefined
        : await runningIdentity(
            context,
            fetchImpl,
            identityRuntime.controlHost,
            identityRuntime.controlPort
          );
    if (identity === undefined) {
      items.push(
        diagnostic(
          "WARN",
          "running_identity_unavailable",
          "Gateway is healthy but authenticated running-version identity could not be read.",
          "If the Owner Passphrase was rotated, restart the gateway; otherwise inspect the loopback control plane."
        )
      );
    } else {
      const installed = await verifyCurrentStandaloneIntegrity(
        context.installation.installRoot
      ).catch(() => undefined);
      if (installed !== undefined && installed.activation.version !== identity.version) {
        items.push(
          diagnostic(
            "FAIL",
            "running_version_mismatch",
            `Installed version ${installed.activation.version} differs from running version ${identity.version}.`,
            "Restart the gateway and verify health before continuing update/rollback operations."
          )
        );
      } else {
        items.push(
          diagnostic(
            "PASS",
            "running_version_match",
            `Running version ${identity.version} matches the active installed release.`
          )
        );
      }
    }
  }

  return Object.freeze(items);
}

export async function showProductConfig(
  dependencies: ManagementDependencies = {}
): Promise<Record<string, unknown>> {
  const context = await discoverInstalledProduct(dependencies);
  const environment = await readRuntimeEnvironmentFile(
    join(context.installation.configRoot, "gateway.env")
  );
  const runtime = readRuntimeConfig(environment);
  const policy = await loadPolicyState(context);
  return {
    installMode: context.installation.installMode,
    serviceMode: context.installation.serviceMode,
    installRoot: context.installation.installRoot,
    stateRoot: context.installation.stateRoot,
    configRoot: context.installation.configRoot,
    releaseChannel: context.installation.releaseChannel,
    host: runtime.host,
    port: runtime.port,
    accessMode: environment.SLNCTRZ_PUBLIC_URL === undefined ? "local" : "public",
    publicMcpUrl: runtime.publicMcpUrl.href,
    ownerConsoleEnabled: runtime.ownerWebEnabled,
    authorityMode: policy.authorityMode ?? "restricted",
    paths: [...policy.paths]
  };
}

function metadataInput(
  installation: InstallationMetadata,
  overrides: {
    readonly host?: string;
    readonly port?: number;
    readonly publicMcpUrl?: string | null;
  } = {}
) {
  const publicMcpUrl = Object.prototype.hasOwnProperty.call(overrides, "publicMcpUrl")
    ? overrides.publicMcpUrl
    : installation.publicMcpUrl;
  return {
    installMode: installation.installMode,
    installRoot: installation.installRoot,
    stateRoot: installation.stateRoot,
    configRoot: installation.configRoot,
    serviceMode: installation.serviceMode,
    serviceName: installation.serviceName,
    releaseChannel: installation.releaseChannel,
    host: overrides.host ?? installation.host,
    port: overrides.port ?? installation.port,
    ...(publicMcpUrl === undefined || publicMcpUrl === null ? {} : { publicMcpUrl }),
    authorityMode: installation.authorityMode,
    initialPath: installation.initialPath
  };
}

export async function setProductConfig(
  key: "port" | "public-url" | "owner-console" | "host",
  value: string,
  dependencies: ManagementDependencies = {}
): Promise<{ readonly restartRequired: true; readonly config: Record<string, unknown> }> {
  const context = await discoverInstalledProduct(dependencies);
  const configFile = join(context.installation.configRoot, "gateway.env");
  const environment = await readRuntimeEnvironmentFile(configFile);
  let metadataOverrides: { host?: string; port?: number; publicMcpUrl?: string | null } = {};

  if (key === "port") {
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("port_invalid: port must be an integer from 1 to 65535");
    }
    environment.SLNCTRZ_PORT = String(port);
    metadataOverrides = { port };
  } else if (key === "host") {
    if (/[\r\n]/u.test(value) || value.length === 0) throw new Error("host_invalid");
    environment.SLNCTRZ_HOST = value;
    metadataOverrides = { host: value };
  } else if (key === "public-url") {
    if (value === "local") {
      delete environment.SLNCTRZ_PUBLIC_URL;
      metadataOverrides = { publicMcpUrl: null };
    } else {
      const publicUrl = new URL(value);
      environment.SLNCTRZ_PUBLIC_URL = value;
      environment.SLNCTRZ_ALLOWED_HOSTS = appendCsvValue(
        environment.SLNCTRZ_ALLOWED_HOSTS,
        publicUrl.hostname
      );
      if (environment.SLNCTRZ_OWNER_WEB_ENABLED === "true") {
        environment.SLNCTRZ_ALLOWED_ORIGINS = appendCsvValue(
          environment.SLNCTRZ_ALLOWED_ORIGINS,
          publicUrl.hostname
        );
      }
      metadataOverrides = { publicMcpUrl: value };
    }
  } else {
    if (value !== "true" && value !== "false") {
      throw new Error("owner_console_invalid: expected true or false");
    }
    environment.SLNCTRZ_OWNER_WEB_ENABLED = value;
  }

  environment.SLNCTRZ_STATE_ROOT = context.installation.stateRoot;
  const validated = readRuntimeConfig(environment);
  await atomicText(configFile, gatewayEnvironmentText(environment), 0o600);
  await writeInstallationMetadata(
    context.statePaths.installationMetadataFile,
    metadataInput(context.installation, {
      ...metadataOverrides,
      host: validated.host,
      port: validated.port,
      ...(environment.SLNCTRZ_PUBLIC_URL === undefined
        ? { publicMcpUrl: null }
        : { publicMcpUrl: validated.publicMcpUrl.href })
    }),
    context.installation
  );
  return { restartRequired: true, config: await showProductConfig(dependencies) };
}

export async function updateProduct(
  options: { readonly manifestUrl?: string } = {},
  dependencies: ManagementDependencies = {}
): Promise<{ readonly activation: ActivationRecord; readonly restartRequired: boolean }> {
  const context = await discoverInstalledProduct(dependencies);
  const manifest = await fetchReleaseManifest(
    options.manifestUrl ?? OFFICIAL_RELEASE_MANIFEST_URL,
    {
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
    }
  );
  const activation = await installStandaloneRelease({
    installRoot: context.installation.installRoot,
    manifest,
    target: currentReleaseTarget(),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
  if (context.installation.installMode === "system") {
    await restartSystemService(context, dependencies);
    return { activation, restartRequired: false };
  }
  return { activation, restartRequired: true };
}

export async function rollbackProduct(
  dependencies: ManagementDependencies = {}
): Promise<{ readonly activation: ActivationRecord; readonly restartRequired: boolean }> {
  const context = await discoverInstalledProduct(dependencies);
  const activation = await rollbackStandaloneRelease({
    installRoot: context.installation.installRoot
  });
  if (context.installation.installMode === "system") {
    await restartSystemService(context, dependencies);
    return { activation, restartRequired: false };
  }
  return { activation, restartRequired: true };
}

export async function repairProduct(
  dependencies: ManagementDependencies = {}
): Promise<{ readonly changes: readonly string[]; readonly restartRequired: boolean }> {
  const context = await discoverInstalledProduct(dependencies);
  const changes: string[] = [];

  if (process.platform !== "win32") {
    const managedDirectories = [
      context.statePaths.root,
      context.statePaths.mcpDirectory,
      context.statePaths.mcpCredentialsDirectory,
      context.statePaths.secretsDirectory
    ];
    const beforeModes = await Promise.all(
      managedDirectories.map(async (path) => (await lstat(path)).mode & 0o777)
    );
    await ensureManagedStateLayout(context.statePaths);
    if (beforeModes.some((mode) => mode !== 0o700)) changes.push("fixed_managed_state_modes");
  } else {
    await ensureManagedStateLayout(context.statePaths);
  }

  const markerFile = join(context.installation.installRoot, "installation-marker.json");
  try {
    await access(markerFile, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await verifyCurrentStandaloneIntegrity(context.installation.installRoot);
    await atomicText(
      markerFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          installationId: context.installation.installationId,
          stateRoot: context.installation.stateRoot
        },
        null,
        2
      )}\n`,
      0o644
    );
    changes.push("restored_installation_marker");
  }

  const platformLayout = userPlatformLayout();
  const launcher = join(context.installation.installRoot, platformLayout.launcherFileName);
  if (platformLayout.launcherKind === "native-copy") {
    let launcherExists = false;
    try {
      const info = await lstat(launcher);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("launcher_invalid");
      launcherExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!launcherExists) {
      await copyFile(
        await resolveCurrentStandaloneExecutable(context.installation.installRoot),
        launcher
      );
      changes.push("restored_launcher");
    }
  } else {
    const expectedLauncher = await productAsset("config/systemd/slnctrz-mcp-launcher.sh");
    let existingLauncher: string | undefined;
    try {
      existingLauncher = await readFile(launcher, "utf8");
    } catch {
      existingLauncher = undefined;
    }
    if (existingLauncher !== expectedLauncher) {
      await atomicText(launcher, expectedLauncher, 0o755);
      changes.push("restored_launcher");
    } else {
      const info = await stat(launcher);
      if ((info.mode & 0o777) !== 0o755) {
        await chmod(launcher, 0o755);
        changes.push("fixed_launcher_mode");
      }
    }
  }

  const staging = join(context.installation.installRoot, ".staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const stagingEntries = await import("node:fs/promises").then(({ readdir }) => readdir(staging));
  if (stagingEntries.length > 0) {
    await Promise.all(
      stagingEntries.map((entry) => rm(join(staging, entry), { recursive: true, force: true }))
    );
    changes.push("cleaned_staging");
  }

  try {
    await access(context.statePaths.commandCatalogFile, constants.F_OK);
  } catch {
    await atomicText(
      context.statePaths.commandCatalogFile,
      await productAsset("config/commands.minimal.json"),
      0o600
    );
    changes.push("restored_minimal_command_catalog");
  }

  try {
    const info = await lstat(context.statePaths.ownerPassphraseFile);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      await chmod(context.statePaths.ownerPassphraseFile, 0o600);
      changes.push("fixed_owner_secret_mode");
    }
  } catch {
    // Never regenerate a missing credential during repair.
  }

  return {
    changes: Object.freeze(changes),
    restartRequired: changes.includes("restored_launcher")
  };
}

export async function rotateOwnerPassphrase(dependencies: ManagementDependencies = {}): Promise<{
  readonly passphrase: string;
  readonly recoveryFile: string;
  readonly restartRequired: true;
}> {
  const context = await discoverInstalledProduct(dependencies);
  const passphrase = randomBytes(24).toString("base64url");
  await atomicText(context.statePaths.ownerPassphraseFile, `${passphrase}\n`, 0o600);
  return {
    passphrase,
    recoveryFile: context.statePaths.ownerPassphraseFile,
    restartRequired: true
  };
}

interface InstallMarker {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly stateRoot: string;
}

async function readInstallMarker(installRoot: string): Promise<InstallMarker> {
  const path = join(installRoot, "installation-marker.json");
  await assertPlainMarker(path, "installation_marker_invalid");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("installation_marker_invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("installation_marker_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.installationId !== "string" ||
    typeof record.stateRoot !== "string" ||
    !isAbsolute(record.stateRoot) ||
    Object.keys(record).some(
      (key) => !["schemaVersion", "installationId", "stateRoot"].includes(key)
    )
  ) {
    throw new Error("installation_marker_invalid");
  }
  return {
    schemaVersion: 1,
    installationId: record.installationId,
    stateRoot: record.stateRoot
  };
}

async function safeManagedRoot(path: string): Promise<string> {
  const normalized = resolve(path);
  if (normalized === dirname(normalized)) throw new Error("managed_root_invalid");
  const info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("managed_root_invalid");
  return normalized;
}

async function assertPlainMarker(path: string, code: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(code);
}

function containsPath(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function powershellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function scheduleWindowsInstallRootRemoval(installRoot: string): Promise<void> {
  const script = [
    `$parentPid=${process.pid}`,
    "Wait-Process -Id $parentPid -ErrorAction SilentlyContinue",
    `$target=${powershellLiteral(installRoot)}`,
    "for ($i = 0; $i -lt 40; $i++) {",
    "  try { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop; exit 0 }",
    "  catch { Start-Sleep -Milliseconds 250 }",
    "}",
    "exit 1"
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

export async function uninstallProduct(
  options: { readonly removeConfig?: boolean; readonly purgeState?: boolean } = {},
  dependencies: ManagementDependencies = {}
): Promise<{
  readonly removed: readonly string[];
  readonly statePreserved: boolean;
  readonly deferredProgramRemoval: boolean;
}> {
  const context = await discoverInstalledProduct(dependencies);
  const installRoot = await safeManagedRoot(context.installation.installRoot);
  const stateRoot = await safeManagedRoot(context.installation.stateRoot);
  await assertPlainMarker(join(installRoot, "current.json"), "standalone_install_marker_invalid");
  await assertPlainMarker(
    context.statePaths.installationMetadataFile,
    "installation_metadata_marker_invalid"
  );
  const stateMarker = await readInstallationMetadata(context.statePaths.installationMetadataFile);
  const installMarker = await readInstallMarker(installRoot);
  if (
    stateMarker?.installationId !== context.installation.installationId ||
    installMarker.installationId !== context.installation.installationId ||
    resolve(installMarker.stateRoot) !== resolve(stateRoot)
  ) {
    throw new Error("installation_identity_mismatch");
  }
  const removed: string[] = [];

  if (context.installation.installMode === "system") {
    const run = dependencies.run ?? defaultRun;
    const disabled = await run("systemctl", ["disable", "--now", "slnctrz-mcp.service"]);
    if (disabled.code !== 0) {
      throw new Error(
        `service_disable_failed: ${disabled.stderr.trim() || disabled.stdout.trim() || disabled.code}`
      );
    }
    const unitFile = join(
      dependencies.serviceUnitRoot ?? "/etc/systemd/system",
      "slnctrz-mcp.service"
    );
    await rm(unitFile, { force: true }).catch(() => undefined);
    const reloaded = await run("systemctl", ["daemon-reload"]);
    if (reloaded.code !== 0) throw new Error("service_daemon_reload_failed");
  }

  const deferredProgramRemoval =
    process.platform === "win32" && containsPath(installRoot, process.execPath);
  if (deferredProgramRemoval) {
    await scheduleWindowsInstallRootRemoval(installRoot);
  } else {
    await rm(installRoot, { recursive: true, force: false });
  }
  removed.push(installRoot);

  if (options.removeConfig || options.purgeState) {
    const configRoot = await safeManagedRoot(context.installation.configRoot);
    await assertPlainMarker(join(configRoot, "gateway.env"), "config_marker_invalid");
    await rm(configRoot, { recursive: true, force: false });
    removed.push(configRoot);
  }
  if (options.purgeState) {
    await rm(stateRoot, { recursive: true, force: false });
    removed.push(stateRoot);
  }

  return {
    removed: Object.freeze(removed),
    statePreserved: !options.purgeState,
    deferredProgramRemoval
  };
}
