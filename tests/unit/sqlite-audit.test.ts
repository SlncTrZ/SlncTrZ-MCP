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
      capabilityId: "core.exec",
      policyVersion: "policy-1",
      result: "success",
      durationMs: 17
    });
    sink.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("SELECT * FROM audit_events").get() as Record<string, unknown>;
    database.close();

    expect(row.category).toBe("tool");
    expect(row.request_id).toBe("req-1");
    expect(row.capability_id).toBe("core.exec");
    expect(row.result).toBe("success");
    expect(row.duration_ms).toBe(17);
    expect(typeof row.build_version).toBe("string");
    expect(typeof row.build_commit).toBe("string");
    expect(Object.keys(row)).not.toContain("args");
    expect(Object.keys(row)).not.toContain("output");
    expect(Object.keys(row)).not.toContain("content");
    expect(Object.keys(row)).not.toContain("credential");
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
