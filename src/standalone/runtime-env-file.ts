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

export function parseRuntimeEnvironmentText(raw: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("gateway_config_invalid");
    const key = line.slice(0, separator);
    if (!RUNTIME_ENV_KEYS.has(key)) throw new Error(`gateway_config_unknown_key: ${key}`);
    const value = line.slice(separator + 1);
    if (/[\r\n]/u.test(value)) throw new Error(`${key} contains a line break`);
    environment[key] = value;
  }
  return environment;
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
