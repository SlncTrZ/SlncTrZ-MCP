/**
 * SQLite Usage Store - bounded metadata-only traffic and harness-savings ledger.
 * Wing: observability | Topic: usage-telemetry | Updated: 2026-09-11
 */

import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";
import { USAGE_ESTIMATOR_ID } from "./usage-estimator.js";
import type {
  HarnessUsageContextStart,
  HarnessUsageDisclosure,
  UsageObserver,
  UsageTrafficEvent
} from "./usage-types.js";
import type {
  UsageRange,
  UsageReader,
  UsageSavings,
  UsageSummary,
  UsageTimeseriesPoint,
  UsageToolBreakdown
} from "./usage-query.js";
import { emptyUsageSavings } from "./usage-query.js";

export const DEFAULT_MAX_PERSISTED_USAGE_ROWS = 250_000;
export const DEFAULT_USAGE_RETENTION_DAYS = 90;
const MAX_PENDING_USAGE_EVENTS = 2_048;
const FLUSH_BATCH_SIZE = 256;
const PRUNE_INTERVAL = 1_024;

interface SqliteUsageOptions {
  readonly maxRows?: number;
  readonly retentionDays?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

type PendingUsage =
  | { readonly kind: "traffic"; readonly event: UsageTrafficEvent }
  | { readonly kind: "harness-start"; readonly event: HarnessUsageContextStart }
  | { readonly kind: "harness-disclosure"; readonly event: HarnessUsageDisclosure };

export interface SqliteUsageStore extends UsageObserver, UsageReader {
  flush(): void;
  close(): void;
}

function validatePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
}

function rangeStart(range: UsageRange, now: number): string | undefined {
  const durations: Partial<Record<UsageRange, number>> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  const duration = durations[range];
  return duration === undefined ? undefined : new Date(now - duration).toISOString();
}

function whereSince(start: string | undefined): { sql: string; params: readonly string[] } {
  return start === undefined
    ? { sql: "", params: [] }
    : { sql: " WHERE timestamp >= ?", params: [start] };
}

function normalizeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function prune(database: DatabaseSync, maxRows: number, retentionDays: number, now: number): void {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  database.prepare("DELETE FROM usage_events WHERE timestamp < ?").run(cutoff);
  database.prepare("DELETE FROM harness_usage_contexts WHERE timestamp < ?").run(cutoff);
  database
    .prepare(
      `DELETE FROM usage_events WHERE id <= COALESCE(
        (SELECT id FROM usage_events ORDER BY id DESC LIMIT 1 OFFSET ?), 0
      )`
    )
    .run(maxRows);
  database
    .prepare(
      `DELETE FROM harness_usage_contexts WHERE rowid <= COALESCE(
        (SELECT rowid FROM harness_usage_contexts ORDER BY rowid DESC LIMIT 1 OFFSET ?), 0
      )`
    )
    .run(maxRows);
}

export function createSqliteUsageStore(
  path: string,
  options: SqliteUsageOptions = {}
): SqliteUsageStore {
  const maxRows = options.maxRows ?? DEFAULT_MAX_PERSISTED_USAGE_ROWS;
  const retentionDays = options.retentionDays ?? DEFAULT_USAGE_RETENTION_DAYS;
  const now = options.now ?? Date.now;
  validatePositiveSafeInteger(maxRows, "Usage maxRows");
  validatePositiveSafeInteger(retentionDays, "Usage retentionDays");

  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  ensureWindowsPrivateAcl(path, "file");
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      tool_id TEXT,
      input_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      estimated_input_tokens INTEGER NOT NULL,
      estimated_output_tokens INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      estimator_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS harness_usage_contexts (
      context_key TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      potential_eager_bytes INTEGER NOT NULL,
      disclosed_bytes INTEGER NOT NULL,
      potential_eager_tokens INTEGER NOT NULL,
      disclosed_tokens INTEGER NOT NULL,
      estimator_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_tool ON usage_events(tool_id);
    CREATE INDEX IF NOT EXISTS idx_harness_usage_timestamp ON harness_usage_contexts(timestamp);
  `);
  prune(database, maxRows, retentionDays, now());

  const insertTraffic = database.prepare(`
    INSERT INTO usage_events (
      timestamp, workspace_id, request_kind, tool_id, input_bytes, output_bytes,
      estimated_input_tokens, estimated_output_tokens, duration_ms, estimator_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHarness = database.prepare(`
    INSERT OR REPLACE INTO harness_usage_contexts (
      context_key, timestamp, workspace_id, potential_eager_bytes, disclosed_bytes,
      potential_eager_tokens, disclosed_tokens, estimator_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const discloseHarness = database.prepare(`
    UPDATE harness_usage_contexts
    SET disclosed_bytes = MIN(potential_eager_bytes, disclosed_bytes + ?),
        disclosed_tokens = MIN(potential_eager_tokens, disclosed_tokens + ?)
    WHERE context_key = ?
  `);

  const pending: PendingUsage[] = [];
  let flushScheduled = false;
  let writesSincePrune = 0;
  let closed = false;

  const flush = (): void => {
    flushScheduled = false;
    if (closed || pending.length === 0) return;
    const batch = pending.splice(0, FLUSH_BATCH_SIZE);
    try {
      database.exec("BEGIN IMMEDIATE");
      for (const item of batch) {
        if (item.kind === "traffic") {
          const event = item.event;
          insertTraffic.run(
            event.timestamp,
            event.workspaceId,
            event.requestKind,
            event.toolId ?? null,
            event.inputBytes,
            event.outputBytes,
            event.estimatedInputTokens,
            event.estimatedOutputTokens,
            event.durationMs,
            USAGE_ESTIMATOR_ID
          );
        } else if (item.kind === "harness-start") {
          const event = item.event;
          insertHarness.run(
            event.contextKey,
            event.timestamp,
            event.workspaceId,
            event.potentialEagerBytes,
            event.disclosedBytes,
            event.potentialEagerEstimatedTokens,
            event.disclosedEstimatedTokens,
            USAGE_ESTIMATOR_ID
          );
        } else {
          discloseHarness.run(
            item.event.additionalBytes,
            item.event.additionalEstimatedTokens,
            item.event.contextKey
          );
        }
      }
      database.exec("COMMIT");
      writesSincePrune += batch.length;
      if (writesSincePrune >= PRUNE_INTERVAL) {
        prune(database, maxRows, retentionDays, now());
        writesSincePrune = 0;
      }
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original persistence failure remains the useful diagnostic.
      }
      options.onError?.(error);
    }
    if (pending.length > 0) scheduleFlush();
  };

  const scheduleFlush = (): void => {
    if (flushScheduled || closed) return;
    flushScheduled = true;
    setImmediate(flush);
  };

  const enqueue = (item: PendingUsage): void => {
    if (closed) return;
    if (pending.length >= MAX_PENDING_USAGE_EVENTS) {
      options.onError?.(new Error("usage_queue_full"));
      return;
    }
    pending.push(item);
    scheduleFlush();
  };

  const queryRows = <T extends Record<string, unknown>>(
    sql: string,
    params: readonly (string | number)[]
  ): T[] => database.prepare(sql).all(...params) as T[];

  const reader: UsageReader = {
    summary(range) {
      flush();
      const start = rangeStart(range, now());
      const filter = whereSince(start);
      const row = database
        .prepare(
          `SELECT COUNT(*) AS calls,
                  COALESCE(SUM(input_bytes), 0) AS input_bytes,
                  COALESCE(SUM(output_bytes), 0) AS output_bytes,
                  COALESCE(SUM(estimated_input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(estimated_output_tokens), 0) AS output_tokens
           FROM usage_events${filter.sql}`
        )
        .get(...filter.params) as Record<string, unknown>;
      const estimatedInputTokens = normalizeInteger(row.input_tokens);
      const estimatedOutputTokens = normalizeInteger(row.output_tokens);
      return {
        available: true,
        range,
        estimatorId: USAGE_ESTIMATOR_ID,
        calls: normalizeInteger(row.calls),
        inputBytes: normalizeInteger(row.input_bytes),
        outputBytes: normalizeInteger(row.output_bytes),
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens
      } satisfies UsageSummary;
    },
    timeseries(range) {
      flush();
      const start = rangeStart(range, now());
      const filter = whereSince(start);
      const bucketExpression =
        range === "24h"
          ? "substr(timestamp, 1, 13) || ':00:00Z'"
          : "substr(timestamp, 1, 10) || 'T00:00:00Z'";
      const traffic = queryRows<{ bucket: string; delivered: number }>(
        `SELECT ${bucketExpression} AS bucket,
                COALESCE(SUM(estimated_output_tokens), 0) AS delivered
         FROM usage_events${filter.sql}
         GROUP BY bucket ORDER BY bucket`,
        filter.params
      );
      const harness = queryRows<{ bucket: string; avoided: number }>(
        `SELECT ${bucketExpression} AS bucket,
                COALESCE(SUM(MAX(potential_eager_tokens - disclosed_tokens, 0)), 0) AS avoided
         FROM harness_usage_contexts${filter.sql}
         GROUP BY bucket ORDER BY bucket`,
        filter.params
      );
      const merged = new Map<string, UsageTimeseriesPoint>();
      for (const row of traffic) {
        merged.set(String(row.bucket), {
          bucket: String(row.bucket),
          deliveredEstimatedTokens: normalizeInteger(row.delivered),
          avoidedEstimatedTokens: 0
        });
      }
      for (const row of harness) {
        const bucket = String(row.bucket);
        const existing = merged.get(bucket);
        merged.set(bucket, {
          bucket,
          deliveredEstimatedTokens: existing?.deliveredEstimatedTokens ?? 0,
          avoidedEstimatedTokens: normalizeInteger(row.avoided)
        });
      }
      return [...merged.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
    },
    tools(range) {
      flush();
      const start = rangeStart(range, now());
      const filter = whereSince(start);
      return queryRows<{
        tool_id: string | null;
        calls: number;
        input_tokens: number;
        output_tokens: number;
      }>(
        `SELECT COALESCE(tool_id, request_kind) AS tool_id,
                COUNT(*) AS calls,
                COALESCE(SUM(estimated_input_tokens), 0) AS input_tokens,
                COALESCE(SUM(estimated_output_tokens), 0) AS output_tokens
         FROM usage_events${filter.sql}
         GROUP BY COALESCE(tool_id, request_kind)
         ORDER BY (SUM(estimated_input_tokens) + SUM(estimated_output_tokens)) DESC
         LIMIT 32`,
        filter.params
      ).map((row) => {
        const estimatedInputTokens = normalizeInteger(row.input_tokens);
        const estimatedOutputTokens = normalizeInteger(row.output_tokens);
        return {
          toolId: row.tool_id ?? "other",
          calls: normalizeInteger(row.calls),
          estimatedInputTokens,
          estimatedOutputTokens,
          estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens
        } satisfies UsageToolBreakdown;
      });
    },
    savings(range) {
      flush();
      const start = rangeStart(range, now());
      const filter = whereSince(start);
      const row = database
        .prepare(
          `SELECT COUNT(*) AS contexts,
                  COALESCE(SUM(potential_eager_tokens), 0) AS potential,
                  COALESCE(SUM(disclosed_tokens), 0) AS disclosed,
                  COALESCE(SUM(MAX(potential_eager_tokens - disclosed_tokens, 0)), 0) AS avoided
           FROM harness_usage_contexts${filter.sql}`
        )
        .get(...filter.params) as Record<string, unknown>;
      const contexts = normalizeInteger(row.contexts);
      if (contexts === 0) return emptyUsageSavings(range);
      const potentialEagerEstimatedTokens = normalizeInteger(row.potential);
      const disclosedEstimatedTokens = normalizeInteger(row.disclosed);
      const avoidedEstimatedTokens = normalizeInteger(row.avoided);
      return {
        available: true,
        range,
        estimatorId: USAGE_ESTIMATOR_ID,
        contexts,
        potentialEagerEstimatedTokens,
        disclosedEstimatedTokens,
        avoidedEstimatedTokens,
        reductionPercent:
          potentialEagerEstimatedTokens === 0
            ? 0
            : Math.round((avoidedEstimatedTokens / potentialEagerEstimatedTokens) * 10_000) / 100
      } satisfies UsageSavings;
    }
  };

  return Object.freeze({
    traffic(event: UsageTrafficEvent) {
      enqueue({ kind: "traffic", event });
    },
    harnessContextStarted(event: HarnessUsageContextStart) {
      enqueue({ kind: "harness-start", event });
    },
    harnessDisclosed(event: HarnessUsageDisclosure) {
      enqueue({ kind: "harness-disclosure", event });
    },
    ...reader,
    flush,
    close() {
      if (closed) return;
      while (pending.length > 0) flush();
      prune(database, maxRows, retentionDays, now());
      closed = true;
      database.close();
    }
  });
}
