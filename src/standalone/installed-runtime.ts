/** Native installed-runtime discovery and Windows launcher delegation. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveCurrentStandaloneExecutable } from "./installer.js";
import { readInstallationMetadata } from "./installation-metadata.js";
import { applyRuntimeEnvironmentFile } from "./runtime-env-file.js";

interface InstallMarker {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly stateRoot: string;
}

function parseMarker(value: unknown): InstallMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("installation marker is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["schemaVersion", "installationId", "stateRoot"].includes(key)
    ) ||
    record.schemaVersion !== 1 ||
    typeof record.installationId !== "string" ||
    record.installationId.length === 0 ||
    typeof record.stateRoot !== "string" ||
    !isAbsolute(record.stateRoot)
  ) {
    throw new Error("installation marker is invalid");
  }
  return {
    schemaVersion: 1,
    installationId: record.installationId,
    stateRoot: record.stateRoot
  };
}

export function samePlatformPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function installedContext(
  executablePath: string,
  platform: NodeJS.Platform
): Promise<
  | {
      readonly installRoot: string;
      readonly marker: InstallMarker;
      readonly configFile: string;
    }
  | undefined
> {
  const installRoot = dirname(executablePath);
  const markerPath = join(installRoot, "installation-marker.json");

  let marker: InstallMarker;
  try {
    marker = parseMarker(JSON.parse(await readFile(markerPath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const metadata = await readInstallationMetadata(join(marker.stateRoot, "installation.json"));
  if (metadata === undefined) throw new Error("installation metadata is unavailable");
  if (
    metadata.installationId !== marker.installationId ||
    !samePlatformPath(metadata.installRoot, installRoot, platform) ||
    !samePlatformPath(metadata.stateRoot, marker.stateRoot, platform)
  ) {
    throw new Error("installed runtime identity does not match installation metadata");
  }

  return {
    installRoot,
    marker,
    configFile: join(metadata.configRoot, "gateway.env")
  };
}

export async function applyInstalledRuntimeEnvironment(
  options: {
    readonly executablePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return false;

  const context = await installedContext(options.executablePath ?? process.execPath, platform);
  if (context === undefined) return false;
  await applyRuntimeEnvironmentFile(context.configFile, options.environment ?? process.env);
  return true;
}

export async function runInstalledLauncherIfNeeded(
  args: readonly string[],
  options: {
    readonly executablePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return false;

  const executablePath = options.executablePath ?? process.execPath;
  const context = await installedContext(executablePath, platform);
  if (context === undefined) return false;

  const environment = options.environment ?? process.env;
  await applyRuntimeEnvironmentFile(context.configFile, environment);
  const active = await resolveCurrentStandaloneExecutable(context.installRoot);
  if (samePlatformPath(active, executablePath, platform)) return false;

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(active, [...args], {
      env: environment,
      stdio: "inherit",
      shell: false,
      windowsHide: false
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  process.exitCode = exitCode;
  return true;
}
