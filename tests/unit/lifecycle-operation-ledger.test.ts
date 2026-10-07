import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationLedger,
  sanitizeDetail,
  verifyOperationIdentity,
  type OperationLedger
} from "../../src/lifecycle/operation-ledger.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-operation-ledger-"));
  cleanup.push(root);
  return join(root, "operations.jsonl");
}

function ledger(
  path: string,
  overrides: { now?: () => number; pid?: number; creationIdentity?: string } = {}
): { ledger: OperationLedger; now: () => number } {
  let tick = Date.parse("2026-10-05T00:00:00.000Z");
  const now = overrides.now ?? (() => (tick += 1000));
  return {
    ledger: createOperationLedger({
      path,
      now,
      pid: overrides.pid ?? 4242,
      creationIdentity: overrides.creationIdentity ?? "boot-epoch-1"
    }),
    now
  };
}

async function lineCount(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

describe("operation ledger", () => {
  it("appends one sanitized event and reloads it after restart", async () => {
    const path = await ledgerPath();
    const first = ledger(path).ledger;
    const record = await first.append({
      operationId: "op-ensure-1",
      engine: "autocad",
      action: "ensure",
      session: "session-1",
      generation: "gen-7",
      detail: { target: "autocad-2027", capability: "native_read" }
    });

    expect(record).toMatchObject({
      operationId: "op-ensure-1",
      engine: "autocad",
      action: "ensure",
      state: "requested",
      pid: 4242,
      creationIdentity: "boot-epoch-1"
    });
    expect(record.createdAt).toBe(record.updatedAt);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("op-ensure-1");
    expect(await lineCount(path)).toBe(1);

    const second = ledger(path).ledger;
    const loaded = await second.load();
    expect(loaded).toEqual({ loaded: 1, skipped: 0 });
    await expect(second.get("op-ensure-1")).resolves.toEqual(record);
  });

  it("reconciles the same operation id and refuses a different payload", async () => {
    const path = await ledgerPath();
    const { ledger: store } = ledger(path);
    const input = {
      operationId: "op-ensure-2",
      engine: "autocad",
      action: "ensure" as const,
      detail: { target: "autocad-2027" }
    };
    const first = await store.append(input);
    await expect(store.append({ ...input })).resolves.toEqual(first);
    expect(await lineCount(path)).toBe(1);

    await expect(store.append({ ...input, engine: "blender" })).rejects.toThrow(
      "operation_id_payload_mismatch"
    );
    await expect(store.append({ ...input, detail: { target: "other-app" } })).rejects.toThrow(
      "operation_id_payload_mismatch"
    );
    await expect(store.append({ ...input, action: "stop" })).rejects.toThrow(
      "operation_id_payload_mismatch"
    );
    expect(await lineCount(path)).toBe(1);
  });

  it("records state transitions for the same request payload", async () => {
    const path = await ledgerPath();
    const { ledger: store } = ledger(path);
    const base = {
      operationId: "op-ensure-3",
      engine: "kicad",
      action: "ensure" as const,
      detail: { target: "kicad-gui" }
    };
    const requested = await store.append(base);
    const progressed = await store.append({ ...base, state: "in_progress" });
    const ready = await store.append({ ...base, state: "ready" });

    expect(progressed.createdAt).toBe(requested.createdAt);
    expect(ready.createdAt).toBe(requested.createdAt);
    expect(ready.updatedAt).not.toBe(requested.createdAt);
    await expect(store.get("op-ensure-3")).resolves.toEqual(ready);
    await expect(store.history("op-ensure-3")).resolves.toEqual([requested, progressed, ready]);
    expect(await lineCount(path)).toBe(3);
  });

  it("never persists secret, credential, or token values", async () => {
    const path = await ledgerPath();
    const { ledger: store } = ledger(path);
    const record = await store.append({
      operationId: "op-ensure-4",
      engine: "autocad",
      action: "ensure",
      detail: {
        target: "autocad-2027",
        ownerSecret: "live-secret-abc-123",
        credentials: { apiKey: "live-key-xyz-789" },
        nested: { deep: { authToken: "live-token-qrs-456" } },
        authorization: "Bearer live-bearer-000",
        passphrase: "live-passphrase-111"
      }
    });

    expect(record.detail).toEqual({
      target: "autocad-2027",
      ownerSecret: "[redacted]",
      credentials: "[redacted]",
      nested: { deep: { authToken: "[redacted]" } },
      authorization: "[redacted]",
      passphrase: "[redacted]"
    });
    expect(sanitizeDetail({ password: "x", ok: 1 })).toEqual({ password: "[redacted]", ok: 1 });

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("live-secret-abc-123");
    expect(raw).not.toContain("live-key-xyz-789");
    expect(raw).not.toContain("live-token-qrs-456");
    expect(raw).not.toContain("live-bearer-000");
    expect(raw).not.toContain("live-passphrase-111");
    expect(raw).toContain("[redacted]");
  });

  it("verifies pid plus creation identity before adopting a recovered operation", async () => {
    const path = await ledgerPath();
    const { ledger: first } = ledger(path);
    const record = await first.append({
      operationId: "op-ensure-5",
      engine: "solidworks",
      action: "ensure",
      session: "session-9",
      generation: "gen-3"
    });

    const { ledger: second } = ledger(path);
    await second.load();
    const recovered = await second.get("op-ensure-5");
    expect(recovered).toEqual(record);
    if (recovered === undefined) throw new Error("expected recovered operation");

    expect(
      verifyOperationIdentity(recovered, {
        pid: 4242,
        creationIdentity: "boot-epoch-1",
        session: "session-9",
        generation: "gen-3"
      })
    ).toBe("owned");
    expect(
      verifyOperationIdentity(recovered, { pid: 9999, creationIdentity: "boot-epoch-1" })
    ).toBe("stale");
    expect(
      verifyOperationIdentity(recovered, { pid: 4242, creationIdentity: "boot-epoch-2" })
    ).toBe("stale");
    expect(
      verifyOperationIdentity(recovered, {
        pid: 4242,
        creationIdentity: "boot-epoch-1",
        session: "session-9",
        generation: "gen-4"
      })
    ).toBe("stale");
  });

  it("serializes concurrent appends without losing operations", async () => {
    const path = await ledgerPath();
    const { ledger: store } = ledger(path);
    const count = 24;
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.append({
          operationId: `op-concurrent-${String(index)}`,
          engine: "blender",
          action: "ensure",
          detail: { slot: index }
        })
      )
    );

    expect(new Set(results.map((record) => record.operationId)).size).toBe(count);
    expect((await store.list()).length).toBe(count);
    expect(await lineCount(path)).toBe(count);

    const duplicates = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.append({
          operationId: "op-concurrent-same",
          engine: "blender",
          action: "ensure",
          detail: { slot: "single" }
        })
      )
    );
    expect(new Set(duplicates.map((record) => record.updatedAt)).size).toBe(1);
    expect(await lineCount(path)).toBe(count + 1);
  });

  it("skips malformed lines on load instead of failing recovery", async () => {
    const path = await ledgerPath();
    const { ledger: first } = ledger(path);
    await first.append({ operationId: "op-good", engine: "kicad", action: "stop" });
    await appendFile(path, "{broken-json\n", "utf8");
    await appendFile(path, `${JSON.stringify({ operationId: 42 })}\n`, "utf8");

    const { ledger: second } = ledger(path);
    const loaded = await second.load();
    expect(loaded).toEqual({ loaded: 1, skipped: 2 });
    await expect(second.get("op-good")).resolves.toMatchObject({ operationId: "op-good" });
    await expect(second.get("missing")).resolves.toBeUndefined();
  });

  it("fails closed for invalid operation input", async () => {
    const path = await ledgerPath();
    const { ledger: store } = ledger(path);
    await expect(
      store.append({ operationId: "", engine: "autocad", action: "ensure" })
    ).rejects.toThrow("operation_id_required");
    await expect(
      store.append({ operationId: "op-bad", engine: "", action: "ensure" })
    ).rejects.toThrow("engine_required");
    await expect(
      store.append({
        operationId: "op-bad",
        engine: "autocad",
        action: "invalid" as unknown as "ensure"
      })
    ).rejects.toThrow("action_invalid");
    await expect(store.get("")).rejects.toThrow("operation_id_required");
    expect(() => createOperationLedger({ path: "" })).toThrow("ledger_path_required");
  });
});
