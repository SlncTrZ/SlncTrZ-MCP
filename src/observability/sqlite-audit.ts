/** Durable metadata-only SQLite audit sink with bounded retention. */

import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { APP_VERSION, BUILD_COMMIT } from "../shared/build-info.js";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";
import type { ExportableAuditEvent } from "./audit-journal.js";

export const DEFAULT_MAX_PERSISTED_AUDIT_ROWS = 250_000;
const PRUNE_INTERVAL = 1_024;

export interface SqliteAuditSink {
  append(event: Readonly<ExportableAuditEvent>): void;
  close(): void;
}

interface SqliteAuditOptions {
  readonly maxRows?: number;
}

function validateMaxRows(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("SQLite audit maxRows must be a positive safe integer");
  }
}

function ensureColumns(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(audit_events)").all() as { name: string }[]).map(
      ({ name }) => name
    )
  );
  const additions = [
    ["command_id", "TEXT"],
    ["provider_id", "TEXT"],
    ["build_version", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["build_commit", "TEXT NOT NULL DEFAULT 'unknown'"]
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name))
      database.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${definition}`);
  }
}

function prune(database: DatabaseSync, maxRows: number): void {
  database
    .prepare(
      `
      DELETE FROM audit_events
      WHERE id <= COALESCE(
        (SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?),
        0
      )
    `
    )
    .run(maxRows);
}

export function createSqliteAuditSink(
  path: string,
  options: SqliteAuditOptions = {}
): SqliteAuditSink {
  const maxRows = options.maxRows ?? DEFAULT_MAX_PERSISTED_AUDIT_ROWS;
  validateMaxRows(maxRows);

  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  ensureWindowsPrivateAcl(path, "file");
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      category TEXT NOT NULL,
      request_id TEXT,
      client_id TEXT,
      workspace_id TEXT,
      capability_id TEXT,
      command_id TEXT,
      provider_id TEXT,
      policy_version TEXT,
      result TEXT NOT NULL,
      duration_ms INTEGER,
      build_version TEXT NOT NULL,
      build_commit TEXT NOT NULL
    );
  `);
  ensureColumns(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_events_category ON audit_events(category);
    CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);
  `);
  prune(database, maxRows);

  const insert = database.prepare(`
    INSERT INTO audit_events (
      timestamp, category, request_id, client_id, workspace_id, capability_id,
      command_id, provider_id, policy_version, result, duration_ms, build_version, build_commit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let writesSincePrune = 0;

  return {
    append(event) {
      insert.run(
        event.timestamp,
        event.category,
        event.requestId ?? null,
        event.clientId ?? null,
        event.workspaceId ?? null,
        event.capabilityId ?? null,
        event.commandId ?? null,
        event.providerId ?? null,
        event.policyVersion ?? null,
        event.result,
        event.durationMs ?? null,
        APP_VERSION,
        BUILD_COMMIT
      );
      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_INTERVAL) {
        prune(database, maxRows);
        writesSincePrune = 0;
      }
    },
    close() {
      prune(database, maxRows);
      database.close();
    }
  };
}
