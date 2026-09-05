/** Product setup orchestration: verified release + managed state + runtime config + installation identity. */

import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { resolveOwnerSecret } from "../auth/owner-secret-store.js";
import {
  ensureManagedStateLayout,
  initializeDefaultWorkspace,
  managedStatePaths,
  resolveApplicationRoot
} from "../owner/managed-state.js";
import { readRuntimeConfig } from "../app/config.js";
import { fetchReleaseManifest } from "./manifest-fetch.js";
import { currentReleaseTarget } from "./release-manifest.js";
import {
  installStandaloneRelease,
  resolveCurrentStandaloneExecutable,
  type ActivationRecord
} from "./installer.js";
import { readStandaloneTextAsset } from "./assets.js";
import {
  readInstallationMetadata,
  writeInstallationMetadata,
  type InstallMode,
  type InstallationMetadata,
  type SetupAuthorityMode
} from "./installation-metadata.js";
import { userPlatformLayout } from "./platform-layout.js";

export const OFFICIAL_RELEASE_MANIFEST_URL =
  "https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/manifest.json";

export interface ProductSetupRequest {
  readonly installMode?: InstallMode;
  readonly port?: number;
  readonly initialPath?: string;
  readonly authorityMode?: SetupAuthorityMode;
  readonly publicMcpUrl?: string;
  readonly listenHost?: string;
  readonly manifestUrl?: string;
  readonly installRoot?: string;
  readonly stateRoot?: string;
  readonly configRoot?: string;
  readonly releaseChannel?: string;
}

export interface ProductSetupResult {
  readonly installation: InstallationMetadata;
  readonly activation: ActivationRecord;
  readonly ownerPassphraseFile: string;
  /** Plaintext is returned only for a newly generated/migrated passphrase in this setup invocation. */
  readonly firstRunOwnerPassphrase?: string;
  readonly ownerPassphraseState: "created" | "preserved" | "migrated";
  readonly gatewayConfigFile: string;
  readonly launcherFile: string;
  readonly mcpEndpoint: string;
  readonly ownerConsoleUrl: string;
  readonly runtimeAccount: string;
}

export interface ProductSetupDependencies {
  readonly fetch?: typeof fetch;
  readonly checkPort?: (host: string, port: number) => Promise<void>;
}

function userDefaults(): { installRoot: string; stateRoot: string; configRoot: string } {
  const layout = userPlatformLayout();
  return {
    installRoot: layout.installRoot,
    stateRoot: layout.stateRoot,
    configRoot: layout.configRoot
  };
}

function systemDefaults(): { installRoot: string; stateRoot: string; configRoot: string } {
  return {
    installRoot: "/opt/slnctrz-mcp",
    stateRoot: "/var/lib/slnctrz-mcp",
    configRoot: "/etc/slnctrz-mcp"
  };
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("setup port must be an integer from 1 to 65535");
  }
  return port;
}

async function defaultCheckPort(host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", (error) =>
      reject(new Error(`port_in_use: ${host}:${port}: ${error.message}`))
    );
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  });
}

async function canonicalInitialPath(path: string): Promise<string> {
  const absolute = requireAbsolute(path, "Initial Path");
  let canonical: string;
  try {
    canonical = await realpath(absolute);
    await access(canonical, constants.R_OK);
  } catch {
    throw new Error("Initial Path must exist and be readable by the setup account");
  }
  return canonical;
}

async function atomicTextFile(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function setupAsset(key: string): Promise<string> {
  const embedded = readStandaloneTextAsset(key);
  if (embedded !== undefined) return embedded;
  return readFile(join(resolveApplicationRoot(), key), "utf8");
}

async function ensureGeneralUserCommandCatalog(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, await setupAsset("config/commands.minimal.json"), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

function runtimeEnvironment(input: {
  host: string;
  port: number;
  stateRoot: string;
  publicMcpUrl?: string;
}): NodeJS.ProcessEnv {
  return {
    SLNCTRZ_HOST: input.host,
    SLNCTRZ_PORT: String(input.port),
    SLNCTRZ_OWNER_WEB_ENABLED: "true",
    SLNCTRZ_STATE_ROOT: input.stateRoot,
    ...(input.publicMcpUrl === undefined ? {} : { SLNCTRZ_PUBLIC_URL: input.publicMcpUrl })
  };
}

function safeEnvValue(value: string, key: string): string {
  if (/[\r\n]/u.test(value)) throw new Error(`${key} must not contain line breaks`);
  return value;
}

function gatewayEnvFile(environment: NodeJS.ProcessEnv): string {
  const ordered = [
    "SLNCTRZ_HOST",
    "SLNCTRZ_PORT",
    "SLNCTRZ_PUBLIC_URL",
    "SLNCTRZ_OWNER_WEB_ENABLED",
    "SLNCTRZ_STATE_ROOT"
  ];
  return `${ordered
    .filter((key) => environment[key] !== undefined)
    .map((key) => `${key}=${safeEnvValue(environment[key] ?? "", key)}`)
    .join("\n")}\n`;
}

export async function prepareProductSetup(
  request: ProductSetupRequest = {},
  dependencies: ProductSetupDependencies = {}
): Promise<ProductSetupResult> {
  const installMode = request.installMode ?? "user";
  if (installMode === "system" && process.platform !== "linux") {
    throw new Error("System setup is currently supported only on Linux");
  }
  const defaults = installMode === "user" ? userDefaults() : systemDefaults();
  const installRoot = requireAbsolute(request.installRoot ?? defaults.installRoot, "Install root");
  const stateRoot = requireAbsolute(request.stateRoot ?? defaults.stateRoot, "State root");
  const configRoot = requireAbsolute(request.configRoot ?? defaults.configRoot, "Config root");
  const port = validatePort(request.port ?? 3100);
  const host = request.listenHost ?? "127.0.0.1";
  const authorityMode = request.authorityMode ?? "restricted";
  const initialPath = await canonicalInitialPath(request.initialPath ?? process.cwd());
  if (installMode === "system" && request.initialPath === undefined) {
    throw new Error("System setup requires an explicit Initial Path");
  }

  const environment = runtimeEnvironment({
    host,
    port,
    stateRoot,
    ...(request.publicMcpUrl === undefined ? {} : { publicMcpUrl: request.publicMcpUrl })
  });
  // Reuse runtime validation so setup cannot generate a configuration the gateway would reject.
  const runtimeConfig = readRuntimeConfig(environment);

  const statePaths = managedStatePaths(stateRoot);
  const existingInstallation = await readInstallationMetadata(statePaths.installationMetadataFile);
  if (existingInstallation === undefined) {
    await (dependencies.checkPort ?? defaultCheckPort)(host, port);
  }

  const manifest = await fetchReleaseManifest(
    request.manifestUrl ?? OFFICIAL_RELEASE_MANIFEST_URL,
    {
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
    }
  );
  const activation = await installStandaloneRelease({
    installRoot,
    manifest,
    target: currentReleaseTarget(),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });

  await ensureManagedStateLayout(statePaths);
  await ensureGeneralUserCommandCatalog(statePaths.commandCatalogFile);
  await initializeDefaultWorkspace({ paths: statePaths, root: initialPath, authorityMode });
  const owner = await resolveOwnerSecret({ secretFile: statePaths.ownerPassphraseFile });

  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const gatewayConfigFile = join(configRoot, "gateway.env");
  await atomicTextFile(gatewayConfigFile, gatewayEnvFile(environment), 0o600);

  const platformLayout = userPlatformLayout();
  const launcherFile = join(installRoot, platformLayout.launcherFileName);
  if (platformLayout.launcherKind === "native-copy") {
    await copyFile(await resolveCurrentStandaloneExecutable(installRoot), launcherFile);
  } else {
    await atomicTextFile(
      launcherFile,
      await setupAsset("config/systemd/slnctrz-mcp-launcher.sh"),
      0o755
    );
  }

  const installation = await writeInstallationMetadata(
    statePaths.installationMetadataFile,
    {
      installMode,
      installRoot,
      stateRoot,
      configRoot,
      serviceMode: installMode === "system" ? "systemd" : "foreground",
      serviceName: "slnctrz-mcp",
      releaseChannel: request.releaseChannel ?? "stable",
      host,
      port,
      ...(request.publicMcpUrl === undefined ? {} : { publicMcpUrl: request.publicMcpUrl }),
      authorityMode,
      initialPath
    },
    existingInstallation
  );
  await atomicTextFile(
    join(installRoot, "installation-marker.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        installationId: installation.installationId,
        stateRoot: installation.stateRoot
      },
      null,
      2
    )}\n`,
    0o644
  );

  let firstRunOwnerPassphrase: string | undefined;
  if (owner.source === "generated" || owner.source === "migrated") {
    firstRunOwnerPassphrase = (await readFile(statePaths.ownerPassphraseFile, "utf8")).replace(
      /\r?\n$/u,
      ""
    );
  }

  const mcpEndpoint = runtimeConfig.publicMcpUrl.href;
  return {
    installation,
    activation,
    ownerPassphraseFile: statePaths.ownerPassphraseFile,
    ...(firstRunOwnerPassphrase === undefined ? {} : { firstRunOwnerPassphrase }),
    ownerPassphraseState:
      owner.source === "generated"
        ? "created"
        : owner.source === "migrated"
          ? "migrated"
          : "preserved",
    gatewayConfigFile,
    launcherFile,
    mcpEndpoint,
    ownerConsoleUrl: `${runtimeConfig.publicMcpUrl.origin}/owner`,
    runtimeAccount: installMode === "system" ? "slnctrz" : userInfo().username
  };
}
