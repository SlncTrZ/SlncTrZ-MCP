/** Strict installed runtime environment-file parsing shared by launch and management paths. */

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
