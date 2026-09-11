import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteUsageStore } from "../../src/observability/sqlite-usage.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function databasePath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), name));
  temporaryDirectories.push(directory);
  return join(directory, "usage.sqlite3");
}

describe("SQLite usage store", () => {
  it("persists numeric/classification metadata only and returns aggregates", async () => {
    const path = await databasePath("slnctrz-usage-");
    const store = createSqliteUsageStore(path, { now: () => Date.parse("2026-09-11T03:00:00Z") });
    store.traffic({
      timestamp: "2026-09-11T02:30:00.000Z",
      workspaceId: "default",
      requestKind: "tools_call",
      toolId: "core.read",
      inputBytes: 100,
      outputBytes: 400,
      estimatedInputTokens: 25,
      estimatedOutputTokens: 100,
      durationMs: 12
    });
    store.harnessContextStarted({
      timestamp: "2026-09-11T02:31:00.000Z",
      contextKey: "usage-context-not-auth-token",
      workspaceId: "default",
      potentialEagerBytes: 4_000,
      disclosedBytes: 1_000,
      potentialEagerEstimatedTokens: 1_000,
      disclosedEstimatedTokens: 250
    });
    store.harnessDisclosed({
      timestamp: "2026-09-11T02:32:00.000Z",
      contextKey: "usage-context-not-auth-token",
      additionalBytes: 400,
      additionalEstimatedTokens: 100
    });
    store.flush();

    expect(store.summary("24h")).toMatchObject({
      calls: 1,
      estimatedInputTokens: 25,
      estimatedOutputTokens: 100,
      estimatedTotalTokens: 125
    });
    expect(store.tools("24h")).toEqual([
      expect.objectContaining({ toolId: "core.read", calls: 1, estimatedTotalTokens: 125 })
    ]);
    expect(store.savings("24h")).toMatchObject({
      contexts: 1,
      potentialEagerEstimatedTokens: 1_000,
      disclosedEstimatedTokens: 350,
      avoidedEstimatedTokens: 650,
      reductionPercent: 65
    });
    expect(store.timeseries("24h")).toEqual([
      {
        bucket: "2026-09-11T02:00:00Z",
        deliveredEstimatedTokens: 100,
        avoidedEstimatedTokens: 650
      }
    ]);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const trafficColumns = database.prepare("PRAGMA table_info(usage_events)").all() as {
      name: string;
    }[];
    const harnessColumns = database.prepare("PRAGMA table_info(harness_usage_contexts)").all() as {
      name: string;
    }[];
    database.close();
    const columns = [...trafficColumns, ...harnessColumns].map(({ name }) => name);
    for (const forbidden of [
      "content",
      "arguments",
      "output",
      "path",
      "credential",
      "context_token",
      "access_token"
    ]) {
      expect(columns).not.toContain(forbidden);
    }
    const raw = await readFile(path);
    expect(raw.includes(Buffer.from("secret payload should never persist"))).toBe(false);
  });

  it("keeps event retention bounded and clamps disclosure at the eager baseline", async () => {
    const path = await databasePath("slnctrz-usage-bounds-");
    const store = createSqliteUsageStore(path, {
      maxRows: 2,
      retentionDays: 90,
      now: () => Date.parse("2026-09-11T03:00:00Z")
    });
    for (let index = 1; index <= 3; index += 1) {
      store.traffic({
        timestamp: `2026-09-11T02:00:0${index}.000Z`,
        workspaceId: "default",
        requestKind: "tools_call",
        toolId: `tool.${index}`,
        inputBytes: 4,
        outputBytes: 4,
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        durationMs: 1
      });
    }
    store.harnessContextStarted({
      timestamp: "2026-09-11T02:10:00.000Z",
      contextKey: "ctx",
      workspaceId: "default",
      potentialEagerBytes: 100,
      disclosedBytes: 40,
      potentialEagerEstimatedTokens: 25,
      disclosedEstimatedTokens: 10
    });
    store.harnessDisclosed({
      timestamp: "2026-09-11T02:11:00.000Z",
      contextKey: "ctx",
      additionalBytes: 10_000,
      additionalEstimatedTokens: 10_000
    });
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT tool_id FROM usage_events ORDER BY id").all() as {
      tool_id: string;
    }[];
    const harness = database
      .prepare(
        "SELECT disclosed_bytes, disclosed_tokens FROM harness_usage_contexts WHERE context_key = 'ctx'"
      )
      .get() as { disclosed_bytes: number; disclosed_tokens: number };
    database.close();
    expect(rows.map(({ tool_id }) => tool_id)).toEqual(["tool.2", "tool.3"]);
    expect(harness).toEqual({ disclosed_bytes: 100, disclosed_tokens: 25 });
  });
});
