/**
 * Lifecycle operation ledger — durable file-backed JSONL operation record.
 *
 * Append-only, fsync-backed, and secret-free: persisted detail is sanitized so
 * caller credentials, tokens, and passphrases never reach disk. Restart
 * recovery reloads the ledger and verifies PID + creation identity before any
 * caller adopts a prior operation.
 *
 * This module is intentionally unwired: it imports no gateway runtime, touches
 * no provider wiring, and adds no tools to the MCP catalog. Wiring points for
 * a future execution controller live in docs/LIFECYCLE_WIRING.md.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LifecycleAction = "ensure" | "stop";

export type OperationState =
  "requested" | "in_progress" | "ready" | "blocked" | "partial" | "failed" | "stopped";

export type OperationOwnership = "owned" | "stale";

export interface SanitizedObject {
  readonly [key: string]: SanitizedValue;
}

export type SanitizedValue =
  string | number | boolean | null | readonly SanitizedValue[] | SanitizedObject;

export type SanitizedDetail = SanitizedObject | readonly SanitizedValue[];

export interface OperationIdentity {
  readonly pid: number;
  readonly creationIdentity: string;
  readonly session?: string;
  readonly generation?: string;
}

export interface ObservedIdentity {
  readonly pid: number;
  readonly creationIdentity: string;
  readonly session?: string;
  readonly generation?: string;
}

export interface OperationRecord extends OperationIdentity {
  readonly operationId: string;
  readonly engine: string;
  readonly action: LifecycleAction;
  readonly state: OperationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly detail?: SanitizedDetail;
}

export interface AppendOperationInput {
  readonly operationId: string;
  readonly engine: string;
  readonly action: LifecycleAction;
  readonly state?: OperationState;
  readonly detail?: unknown;
  readonly pid?: number;
  readonly creationIdentity?: string;
  readonly session?: string;
  readonly generation?: string;
}

export interface OperationLedgerOptions {
  readonly path: string;
  readonly now?: () => number;
  readonly pid?: number;
  readonly creationIdentity?: string;
}

export interface OperationLedgerLoad {
  readonly loaded: number;
  readonly skipped: number;
}

export interface OperationLedger {
  append(input: AppendOperationInput): Promise<OperationRecord>;
  get(operationId: string): Promise<OperationRecord | undefined>;
  history(operationId: string): Promise<readonly OperationRecord[]>;
  list(): Promise<readonly OperationRecord[]>;
  load(): Promise<OperationLedgerLoad>;
}

const MAX_OPERATION_ID = 128;
const MAX_ENGINE = 64;
const MAX_IDENTITY = 256;
const MAX_SESSION = 128;
const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_KEYS = 50;
const MAX_DETAIL_ITEMS = 100;
const MAX_DETAIL_STRING = 4000;

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";

const SENSITIVE_KEY_PATTERN =
  /(secret|credential|token|passphrase|password|passwd|authorization|cookie|privatekey|apikey|bearer|sessionkey|clientsecret|otp|ssn)/iu;

const BEARER_VALUE_PATTERN = /^\s*(bearer|basic|token)\s+\S+/iu;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

function sanitizeValue(value: unknown, depth: number): SanitizedValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    if (BEARER_VALUE_PATTERN.test(value)) return REDACTED;
    return value.length > MAX_DETAIL_STRING
      ? `${value.slice(0, MAX_DETAIL_STRING)}${TRUNCATED}`
      : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DETAIL_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const clean: SanitizedValue[] = [];
    for (const item of value.slice(0, MAX_DETAIL_ITEMS)) {
      const entry = sanitizeValue(item, depth + 1);
      if (entry !== undefined) clean.push(entry);
    }
    return Object.freeze(clean);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const clean: Record<string, SanitizedValue> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_DETAIL_KEYS)) {
    if (key.length === 0 || key.length > MAX_IDENTITY) continue;
    if (isSensitiveKey(key)) {
      clean[key] = REDACTED;
      continue;
    }
    const sanitized = sanitizeValue(entry, depth + 1);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return Object.freeze(clean);
}

/**
 * Strip secret-bearing values from caller detail before persistence. Key names
 * are retained so operators can see that a credential was present; values are
 * replaced with `[redacted]` and never reach disk.
 */
export function sanitizeDetail(value: unknown): SanitizedDetail | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeValue(value, 0);
  if (clean === null || typeof clean !== "object") return undefined;
  return clean;
}

function isDetailObject(value: SanitizedDetail): value is SanitizedObject {
  return !Array.isArray(value);
}

function deepFreezeValue(value: SanitizedValue): SanitizedValue {
  if (typeof value === "object" && value !== null) return deepFreezeDetail(value);
  return value;
}

function deepFreezeDetail(value: SanitizedDetail): SanitizedDetail {
  if (!isDetailObject(value)) {
    for (const item of value) {
      if (typeof item === "object" && item !== null) deepFreezeValue(item);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    const entry: SanitizedValue | undefined = value[key];
    if (typeof entry === "object" && entry !== null) {
      deepFreezeValue(entry);
    }
  }
  return Object.freeze(value);
}

function sortDetailKeys(value: SanitizedValue): unknown {
  if (typeof value === "object" && value !== null) return sortDetailObject(value);
  return value;
}

function sortDetailObject(value: SanitizedDetail): unknown {
  if (!isDetailObject(value)) return value.map(sortDetailKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry: SanitizedValue | undefined = value[key];
    if (entry !== undefined) sorted[key] = sortDetailKeys(entry);
  }
  return sorted;
}

function stableDetail(detail: SanitizedDetail | undefined): string {
  if (detail === undefined) return "";
  return JSON.stringify(sortDetailKeys(detail));
}

function normalizeOptional(value: string | undefined): string {
  return value ?? "";
}

function assertOperationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("operation_id_required");
  if (value.length > MAX_OPERATION_ID) throw new Error("operation_id_too_long");
  return value;
}

function assertEngine(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("engine_required");
  if (value.length > MAX_ENGINE) throw new Error("engine_too_long");
  return value;
}

function assertAction(value: unknown): LifecycleAction {
  if (value === "ensure" || value === "stop") return value;
  throw new Error("action_invalid");
}

function assertState(value: unknown): OperationState {
  if (
    value === "requested" ||
    value === "in_progress" ||
    value === "ready" ||
    value === "blocked" ||
    value === "partial" ||
    value === "failed" ||
    value === "stopped"
  ) {
    return value;
  }
  throw new Error("state_invalid");
}

function assertPid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("pid_invalid");
  }
  return value;
}

function assertIdentityField(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name}_required`);
  if (value.length > max) throw new Error(`${name}_too_long`);
  return value;
}

function assertOptionalField(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function validRecord(value: unknown): OperationRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.operationId !== "string" || record.operationId.length === 0) return undefined;
  if (record.operationId.length > MAX_OPERATION_ID) return undefined;
  if (typeof record.engine !== "string" || record.engine.length === 0) return undefined;
  if (record.engine.length > MAX_ENGINE) return undefined;
  if (record.action !== "ensure" && record.action !== "stop") return undefined;
  let state: OperationState;
  try {
    state = assertState(record.state);
  } catch {
    return undefined;
  }
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    return undefined;
  }
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    return undefined;
  }
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    return undefined;
  }
  if (
    typeof record.creationIdentity !== "string" ||
    record.creationIdentity.length === 0 ||
    record.creationIdentity.length > MAX_IDENTITY
  ) {
    return undefined;
  }
  if (
    record.session !== undefined &&
    (typeof record.session !== "string" ||
      record.session.length === 0 ||
      record.session.length > MAX_SESSION)
  ) {
    return undefined;
  }
  if (
    record.generation !== undefined &&
    (typeof record.generation !== "string" ||
      record.generation.length === 0 ||
      record.generation.length > MAX_SESSION)
  ) {
    return undefined;
  }
  if (record.detail !== undefined) {
    const clean = sanitizeValue(record.detail, 0);
    if (clean === null || typeof clean !== "object") return undefined;
    return Object.freeze({
      operationId: record.operationId,
      engine: record.engine,
      action: record.action,
      state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pid: record.pid,
      creationIdentity: record.creationIdentity,
      ...(typeof record.session === "string" ? { session: record.session } : {}),
      ...(typeof record.generation === "string" ? { generation: record.generation } : {}),
      detail: deepFreezeDetail(clean)
    });
  }
  return Object.freeze({
    operationId: record.operationId,
    engine: record.engine,
    action: record.action,
    state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pid: record.pid,
    creationIdentity: record.creationIdentity,
    ...(typeof record.session === "string" ? { session: record.session } : {}),
    ...(typeof record.generation === "string" ? { generation: record.generation } : {})
  });
}

/**
 * Fail closed on identity mismatch: a restarted controller or supervisor must
 * reconcile actual process state before adopting a persisted operation.
 */
export function verifyOperationIdentity(
  record: OperationRecord,
  observed: ObservedIdentity
): OperationOwnership {
  if (
    record.pid !== observed.pid ||
    record.creationIdentity !== observed.creationIdentity ||
    normalizeOptional(record.session) !== normalizeOptional(observed.session) ||
    normalizeOptional(record.generation) !== normalizeOptional(observed.generation)
  ) {
    return "stale";
  }
  return "owned";
}

function sameRequest(
  existing: OperationRecord,
  candidate: {
    readonly engine: string;
    readonly action: LifecycleAction;
    readonly session: string | undefined;
    readonly generation: string | undefined;
    readonly detail: SanitizedDetail | undefined;
  }
): boolean {
  return (
    existing.engine === candidate.engine &&
    existing.action === candidate.action &&
    normalizeOptional(existing.session) === normalizeOptional(candidate.session) &&
    normalizeOptional(existing.generation) === normalizeOptional(candidate.generation) &&
    stableDetail(existing.detail) === stableDetail(candidate.detail)
  );
}

function sameEvent(
  existing: OperationRecord,
  candidate: {
    readonly state: OperationState;
    readonly pid: number;
    readonly creationIdentity: string;
    readonly session: string | undefined;
    readonly generation: string | undefined;
    readonly detail: SanitizedDetail | undefined;
  }
): boolean {
  return (
    existing.state === candidate.state &&
    existing.pid === candidate.pid &&
    existing.creationIdentity === candidate.creationIdentity &&
    normalizeOptional(existing.session) === normalizeOptional(candidate.session) &&
    normalizeOptional(existing.generation) === normalizeOptional(candidate.generation) &&
    stableDetail(existing.detail) === stableDetail(candidate.detail)
  );
}

export function createOperationLedger(options: OperationLedgerOptions): OperationLedger {
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new Error("ledger_path_required");
  }
  const path = options.path;
  const now = options.now ?? Date.now;
  const defaultPid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(defaultPid) || defaultPid <= 0) throw new Error("pid_invalid");
  const defaultCreationIdentity =
    options.creationIdentity ?? `pid-${String(defaultPid)}-epoch-${String(now())}`;
  if (defaultCreationIdentity.length === 0 || defaultCreationIdentity.length > MAX_IDENTITY) {
    throw new Error("creation_identity_invalid");
  }

  const latest = new Map<string, OperationRecord>();
  const histories = new Map<string, OperationRecord[]>();
  let loadedFromDisk = false;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function readLocked(): Promise<OperationLedgerLoad> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        latest.clear();
        histories.clear();
        loadedFromDisk = true;
        return Object.freeze({ loaded: 0, skipped: 0 });
      }
      throw error;
    }
    latest.clear();
    histories.clear();
    let loaded = 0;
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        skipped += 1;
        continue;
      }
      const record = validRecord(parsed);
      if (record === undefined) {
        skipped += 1;
        continue;
      }
      const events = histories.get(record.operationId) ?? [];
      events.push(record);
      histories.set(record.operationId, events);
      latest.set(record.operationId, record);
      loaded += 1;
    }
    loadedFromDisk = true;
    return Object.freeze({ loaded, skipped });
  }

  async function ensureLoadedLocked(): Promise<void> {
    if (!loadedFromDisk) await readLocked();
  }

  async function persistLocked(record: OperationRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const ledger: OperationLedger = {
    async append(input) {
      return enqueue(async () => {
        const operationId = assertOperationId(input.operationId);
        const engine = assertEngine(input.engine);
        const action = assertAction(input.action);
        const state = input.state === undefined ? "requested" : assertState(input.state);
        const detail = sanitizeDetail(input.detail);
        const pid = input.pid === undefined ? defaultPid : assertPid(input.pid);
        const creationIdentity =
          input.creationIdentity === undefined
            ? defaultCreationIdentity
            : assertIdentityField(input.creationIdentity, "creation_identity", MAX_IDENTITY);
        const session = assertOptionalField(input.session, "session", MAX_SESSION);
        const generation = assertOptionalField(input.generation, "generation", MAX_SESSION);

        await ensureLoadedLocked();
        const timestamp = new Date(now()).toISOString();
        const candidate = { engine, action, session, generation, detail };
        const existing = latest.get(operationId);
        if (existing !== undefined) {
          if (!sameRequest(existing, candidate)) {
            throw new Error("operation_id_payload_mismatch");
          }
          if (
            sameEvent(existing, {
              state,
              pid,
              creationIdentity,
              session,
              generation,
              detail
            })
          ) {
            return existing;
          }
          const first = histories.get(operationId)?.[0];
          const createdAt = first?.createdAt ?? existing.createdAt;
          const transitioned: OperationRecord = Object.freeze({
            operationId,
            engine,
            action,
            state,
            createdAt,
            updatedAt: timestamp,
            pid,
            creationIdentity,
            ...(session === undefined ? {} : { session }),
            ...(generation === undefined ? {} : { generation }),
            ...(detail === undefined ? {} : { detail })
          });
          await persistLocked(transitioned);
          latest.set(operationId, transitioned);
          histories.get(operationId)?.push(transitioned);
          return transitioned;
        }
        const record: OperationRecord = Object.freeze({
          operationId,
          engine,
          action,
          state,
          createdAt: timestamp,
          updatedAt: timestamp,
          pid,
          creationIdentity,
          ...(session === undefined ? {} : { session }),
          ...(generation === undefined ? {} : { generation }),
          ...(detail === undefined ? {} : { detail })
        });
        await persistLocked(record);
        latest.set(operationId, record);
        histories.set(operationId, [record]);
        return record;
      });
    },

    async get(operationId) {
      return enqueue(async () => {
        await ensureLoadedLocked();
        return latest.get(assertOperationId(operationId));
      });
    },

    async history(operationId) {
      return enqueue(async () => {
        await ensureLoadedLocked();
        return Object.freeze([...(histories.get(assertOperationId(operationId)) ?? [])]);
      });
    },

    async list() {
      return enqueue(async () => {
        await ensureLoadedLocked();
        return Object.freeze([...latest.values()]);
      });
    },

    async load() {
      return enqueue(readLocked);
    }
  };
  return Object.freeze(ledger);
}
