import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAuditSink } from "../../src/observability/sqlite-audit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("SQLite audit sink", () => {
  it("persists only the privacy-reviewed metadata projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slnctrz-audit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.sqlite3");
    const sink = createSqliteAuditSink(path);
    sink.append({
      timestamp: "2026-09-03T10:00:00.123Z",
      category: "tool",
      requestId: "req-1",
      clientId: "client-1",
      workspaceId: "default",
      capabilityId: "sample.echo",
      providerId: "sample",
      correlationId: "provider-incident-1",
      providerFailureClass: "transport_failure",
      recoveryState: "recovering",
      lifecycleReason: "SIGTERM",
      authReason: "pkce_mismatch",
      authOperation: "token_exchange",
      policyVersion: "policy-1",
      result: "error",
      durationMs: 17
    });
    sink.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("SELECT * FROM audit_events").get() as Record<string, unknown>;
    database.close();

    expect(row.category).toBe("tool");
    expect(row.request_id).toBe("req-1");
    expect(row.capability_id).toBe("sample.echo");
    expect(row.provider_id).toBe("sample");
    expect(row.correlation_id).toBe("provider-incident-1");
    expect(row.provider_failure_class).toBe("transport_failure");
    expect(row.recovery_state).toBe("recovering");
    expect(row.lifecycle_reason).toBe("SIGTERM");
    expect(row.auth_reason).toBe("pkce_mismatch");
    expect(row.auth_operation).toBe("token_exchange");
    expect(row.result).toBe("error");
    expect(row.duration_ms).toBe(17);
    expect(typeof row.build_version).toBe("string");
    expect(typeof row.build_commit).toBe("string");
    expect(Object.keys(row)).not.toContain("args");
    expect(Object.keys(row)).not.toContain("output");
    expect(Object.keys(row)).not.toContain("content");
    expect(Object.keys(row)).not.toContain("credential");
  });

  it("migrates an existing audit database with auth diagnostic columns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slnctrz-audit-migrate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.sqlite3");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        request_id TEXT,
        client_id TEXT,
        workspace_id TEXT,
        capability_id TEXT,
        policy_version TEXT,
        result TEXT NOT NULL,
        duration_ms INTEGER
      );
    `);
    legacy.close();

    const sink = createSqliteAuditSink(path);
    sink.append({
      timestamp: "2026-09-23T00:00:00.000Z",
      category: "auth",
      capabilityId: "token.exchange_rejected",
      authReason: "pkce_mismatch",
      authOperation: "token_exchange",
      result: "error"
    });
    sink.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database
      .prepare("SELECT auth_reason, auth_operation FROM audit_events")
      .get() as Record<string, unknown>;
    database.close();

    expect(row.auth_reason).toBe("pkce_mismatch");
    expect(row.auth_operation).toBe("token_exchange");
  });

  it("keeps durable history bounded to the configured maximum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slnctrz-audit-retention-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.sqlite3");
    const sink = createSqliteAuditSink(path, { maxRows: 2 });
    for (let index = 1; index <= 3; index += 1) {
      sink.append({
        timestamp: `2026-09-03T10:00:0${index}.000Z`,
        category: "tool",
        requestId: `req-${index}`,
        capabilityId: "core.ping",
        result: "success"
      });
    }
    sink.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT request_id FROM audit_events ORDER BY id").all() as {
      request_id: string;
    }[];
    database.close();

    expect(rows.map(({ request_id }) => request_id)).toEqual(["req-2", "req-3"]);
  });
});
