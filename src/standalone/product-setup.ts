/** Product setup orchestration: verified release + managed state + runtime config + installation identity.
 * Wing: standalone | Topic: coding-harness-integration | Updated: 2026-09-09
 */

import { ensureHarnessLayout } from "../context/provisioning.js";
import { readRuntimeEnvironmentFile } from "./runtime-env-file.js";
import { randomBytes } from "node:crypto";
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
import { isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { resolveOwnerSecret } from "../auth/owner-secret-store.js";
import {
  ensureManagedStateLayout,
  initializeDefaultWorkspace,
  managedStatePaths,
  resolveApplicationRoot
} from "../owner/managed-state.js";
import {
  DEFAULT_STATIC_CLIENT_ID,
  DEFAULT_STATIC_CLIENT_REDIRECT_URIS,
  readRuntimeConfig
} from "../app/config.js";
import { fetchReleaseManifest } from "./manifest-fetch.js";
import type { ReleaseTrustKey } from "./release-signature.js";
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
import { provisionDefaultCommandCatalog } from "../owner/command-catalog-provisioning.js";
import {
  resolveRuntimeIdentity,
  runtimeCanExecuteBinary,
  type RuntimeIdentity
} from "./runtime-identity.js";

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
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export interface ProductSetupResult {
  readonly harnessRoot?: string;
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
  readonly runtimeIdentity: RuntimeIdentity;
  /** Auto-provisioned static confidential-client credentials for OAuth-protected servers. */
  readonly staticClientId: string;
  /** Path of the generated/edited client.env. */
  readonly staticClientFile: string;
  /** Plaintext secret is returned only for a freshly generated client.env in this invocation. */
  readonly firstRunStaticClientSecret?: string;
}

export interface ProductSetupDependencies {
  readonly fetch?: typeof fetch;
  readonly checkPort?: (host: string, port: number) => Promise<void>;
  readonly resolveRuntimeIdentity?: (installMode: InstallMode) => RuntimeIdentity;
  readonly verifyRuntimeBinary?: (
    identity: RuntimeIdentity,
    binary: string
  ) => boolean | Promise<boolean>;
  readonly releaseTrustKeys?: readonly ReleaseTrustKey[];
}

function userDefaults(home: string): {
  installRoot: string;
  stateRoot: string;
  configRoot: string;
} {
  const layout = userPlatformLayout(process.platform, process.env, home);
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

const CLIENT_ENV_PATTERNS = Object.freeze({
  id: /^SLNCTRZ_CLIENT_ID=(.*)$/mu,
  secret: /^SLNCTRZ_CLIENT_SECRET=(.*)$/mu,
  name: /^SLNCTRZ_CLIENT_NAME=(.*)$/mu,
  redirectUris: /^SLNCTRZ_CLIENT_REDIRECT_URIS=(.*)$/mu
});

/**
 * Auto-provision a static confidential-client file (configRoot/client.env). Existing
 * credentials survive setup unless the owner explicitly supplies a replacement ID or secret.
 */
export async function ensureClientEnvFile(
  configRoot: string,
  requested: { clientId?: string; clientSecret?: string }
): Promise<{
  file: string;
  clientId: string;
  clientSecret: string;
  created: boolean;
}> {
  const file = join(configRoot, "client.env");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const existingClientId = existing.match(CLIENT_ENV_PATTERNS.id)?.[1];
  const existingClientSecret = existing.match(CLIENT_ENV_PATTERNS.secret)?.[1];
  if (
    requested.clientId === undefined &&
    requested.clientSecret === undefined &&
    existingClientId !== undefined &&
    existingClientId.length > 0 &&
    existingClientSecret !== undefined &&
    existingClientSecret.length > 0
  ) {
    return {
      file,
      clientId: existingClientId,
      clientSecret: existingClientSecret,
      created: false
    };
  }

  const clientId = safeEnvValue(
    requested.clientId ?? existingClientId ?? DEFAULT_STATIC_CLIENT_ID,
    "Client ID"
  );
  const requestedSecret =
    requested.clientSecret ?? (existingClientSecret?.length ? existingClientSecret : undefined);
  const clientSecret = safeEnvValue(
    requestedSecret ?? randomBytes(24).toString("hex"),
    "Client Secret"
  );
  if (clientId.length === 0) throw new Error("Client ID must not be empty");
  if (clientSecret.length === 0) throw new Error("Client Secret must not be empty");

  const clientName = existing.match(CLIENT_ENV_PATTERNS.name)?.[1] ?? "SlncTrZ-MCP";
  const redirectUris =
    existing.match(CLIENT_ENV_PATTERNS.redirectUris)?.[1] ??
    DEFAULT_STATIC_CLIENT_REDIRECT_URIS.join(",");
  const content =
    [
      `SLNCTRZ_CLIENT_ID=${clientId}`,
      `SLNCTRZ_CLIENT_SECRET=${clientSecret}`,
      `SLNCTRZ_CLIENT_NAME=${clientName}`,
      `SLNCTRZ_CLIENT_REDIRECT_URIS=${redirectUris}`
    ].join("\n") + "\n";
  await atomicTextFile(file, content, 0o600);
  return { file, clientId, clientSecret, created: requestedSecret === undefined };
}

function gatewayEnvFile(environment: NodeJS.ProcessEnv): string {
  const ordered = [
    "SLNCTRZ_HOST",
    "SLNCTRZ_PORT",
    "SLNCTRZ_PUBLIC_URL",
    "SLNCTRZ_OWNER_WEB_ENABLED",
    "SLNCTRZ_STATE_ROOT",
    "SLNCTRZ_HARNESS_ROOT"
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
  const runtimeIdentity =
    dependencies.resolveRuntimeIdentity?.(installMode) ?? resolveRuntimeIdentity({ installMode });
  const defaults = installMode === "user" ? userDefaults(runtimeIdentity.home) : systemDefaults();
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
  try {
    const previous = await readRuntimeEnvironmentFile(join(configRoot, "gateway.env"));
    if (previous.SLNCTRZ_HARNESS_ROOT !== undefined)
      environment.SLNCTRZ_HARNESS_ROOT = previous.SLNCTRZ_HARNESS_ROOT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.releaseTrustKeys === undefined
        ? {}
        : { trustedKeys: dependencies.releaseTrustKeys })
    }
  );
  const activation = await installStandaloneRelease({
    installRoot,
    manifest,
    target: currentReleaseTarget(),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });

  await ensureManagedStateLayout(statePaths);
  await ensureHarnessLayout(runtimeConfig.harnessRoot ?? join(stateRoot, "harness"));
  await provisionDefaultCommandCatalog({
    paths: statePaths,
    appRoot: resolveApplicationRoot(),
    pathValue: runtimeIdentity.runtimePath,
    ...(installMode === "system"
      ? {
          verifyResolvedBinary: (binary: string) =>
            dependencies.verifyRuntimeBinary?.(runtimeIdentity, binary) ??
            runtimeCanExecuteBinary(runtimeIdentity, binary)
        }
      : {})
  });
  await initializeDefaultWorkspace({ paths: statePaths, root: initialPath, authorityMode });
  const owner = await resolveOwnerSecret({ secretFile: statePaths.ownerPassphraseFile });

  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const gatewayConfigFile = join(configRoot, "gateway.env");
  await atomicTextFile(gatewayConfigFile, gatewayEnvFile(environment), 0o600);
  const staticClient = await ensureClientEnvFile(configRoot, {
    ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
    ...(request.clientSecret === undefined ? {} : { clientSecret: request.clientSecret })
  });

  const platformLayout = userPlatformLayout(process.platform, process.env, runtimeIdentity.home);
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
    harnessRoot: runtimeConfig.harnessRoot ?? join(stateRoot, "harness"),
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
    runtimeAccount: runtimeIdentity.username,
    runtimeIdentity,
    staticClientId: staticClient.clientId,
    staticClientFile: staticClient.file,
    ...(staticClient.created ? { firstRunStaticClientSecret: staticClient.clientSecret } : {})
  };
}
