/** Strict installed runtime environment-file parsing shared by launch and management paths.
 * Wing: standalone | Topic: coding-harness-integration | Updated: 2026-09-09
 */

import { readFile } from "node:fs/promises";

export const RUNTIME_ENV_KEYS = Object.freeze(
  new Set([
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
    "SLNCTRZ_HARNESS_ROOT",
    "SLNCTRZ_POLICY_FILE"
  ])
);

export const CLIENT_ENV_KEYS = Object.freeze(
  new Set([
    "SLNCTRZ_CLIENT_ID",
    "SLNCTRZ_CLIENT_SECRET",
    "SLNCTRZ_CLIENT_NAME",
    "SLNCTRZ_CLIENT_REDIRECT_URIS"
  ])
);

const RUNTIME_ENV_MINIMUM_VERSION = Object.freeze(
  new Map<string, string>([["SLNCTRZ_HARNESS_ROOT", "0.3.0"]])
);

function versionTuple(version: string): readonly [number, number, number] {
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      version
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`runtime_config_target_version_invalid: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: string, minimum: string): boolean {
  const current = versionTuple(version);
  const required = versionTuple(minimum);
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export function assertRuntimeEnvironmentCompatibleWithRelease(
  environment: NodeJS.ProcessEnv,
  targetVersion: string
): void {
  for (const [key, minimumVersion] of RUNTIME_ENV_MINIMUM_VERSION) {
    if (environment[key] !== undefined && !versionAtLeast(targetVersion, minimumVersion)) {
      throw new Error(
        `rollback_config_incompatible: ${key} requires ${minimumVersion} or newer; rollback target is ${targetVersion}`
      );
    }
  }
}

function parseEnvironmentText(
  raw: string,
  allowedKeys: ReadonlySet<string>,
  invalidPrefix: string,
  unknownPrefix: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${invalidPrefix}_invalid`);
    const key = line.slice(0, separator);
    if (!allowedKeys.has(key)) throw new Error(`${unknownPrefix}_unknown_key: ${key}`);
    const value = line.slice(separator + 1);
    if (/[\r\n]/u.test(value)) throw new Error(`${key} contains a line break`);
    environment[key] = value;
  }
  return environment;
}

export function parseRuntimeEnvironmentText(raw: string): NodeJS.ProcessEnv {
  return parseEnvironmentText(raw, RUNTIME_ENV_KEYS, "gateway_config", "gateway_config");
}

export async function readRuntimeEnvironmentFile(path: string): Promise<NodeJS.ProcessEnv> {
  return parseRuntimeEnvironmentText(await readFile(path, "utf8"));
}

export async function applyRuntimeEnvironmentFile(
  path: string,
  target: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const loaded = await readRuntimeEnvironmentFile(path);
  for (const [key, value] of Object.entries(loaded)) {
    if (value !== undefined) target[key] = value;
  }
}

export function parseClientEnvironmentText(raw: string): NodeJS.ProcessEnv {
  return parseEnvironmentText(raw, CLIENT_ENV_KEYS, "client_config", "client_config");
}

export async function readClientEnvironmentFile(path: string): Promise<NodeJS.ProcessEnv> {
  return parseClientEnvironmentText(await readFile(path, "utf8"));
}

export async function applyClientEnvironmentFile(
  path: string,
  target: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let loaded: NodeJS.ProcessEnv;
  try {
    loaded = await readClientEnvironmentFile(path);
  } catch (error) {
    // client.env is optional: an install created before static-client provisioning has no file.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (value !== undefined) target[key] = value;
  }
}
