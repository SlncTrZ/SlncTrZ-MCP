/** Gateway lifecycle observability — safe one-shot restart intent and reason types. */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export type GatewayLifecycleReason =
  | "SIGTERM"
  | "SIGINT"
  | "requested"
  | "startup_failure"
  | "release_restart"
  | "control_restart"
  | "owner_restart";

export type GatewayRestartIntentReason = Extract<
  GatewayLifecycleReason,
  "release_restart" | "control_restart" | "owner_restart"
>;

export interface GatewayLifecycleIntent {
  readonly reason: GatewayRestartIntentReason;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const INTENT_TTL_MS = 10 * 60 * 1000;

function isRestartIntentReason(value: unknown): value is GatewayRestartIntentReason {
  return value === "release_restart" || value === "control_restart" || value === "owner_restart";
}

function validIntent(value: unknown, nowMs: number): GatewayLifecycleIntent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isRestartIntentReason(record.reason) ||
    typeof record.correlationId !== "string" ||
    record.correlationId.length < 1 ||
    record.correlationId.length > 128 ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    return undefined;
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return undefined;
  return Object.freeze({
    reason: record.reason,
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  });
}

export async function writeGatewayLifecycleIntent(
  path: string,
  reason: GatewayRestartIntentReason,
  options: {
    readonly now?: () => number;
    readonly correlationId?: () => string;
  } = {}
): Promise<GatewayLifecycleIntent> {
  const nowMs = (options.now ?? Date.now)();
  const intent: GatewayLifecycleIntent = Object.freeze({
    reason,
    correlationId: (options.correlationId ?? randomUUID)(),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + INTENT_TTL_MS).toISOString()
  });
  const temporary = `${path}.tmp-${process.pid}-${nowMs}`;
  try {
    await writeFile(temporary, `${JSON.stringify(intent)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return intent;
}

export async function consumeGatewayLifecycleIntent(
  path: string,
  now: () => number = Date.now
): Promise<GatewayLifecycleIntent | undefined> {
  const claimed = `${path}.consume-${process.pid}-${now()}`;
  try {
    await rename(path, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(claimed, "utf8")) as unknown;
    } catch {
      return undefined;
    }
    return validIntent(parsed, now());
  } finally {
    await rm(claimed, { force: true }).catch(() => undefined);
  }
}
