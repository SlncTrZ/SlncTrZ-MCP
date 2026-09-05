import { describe, expect, it } from "vitest";
import { createTaskRuntime } from "../../src/task/runtime.js";

const A = { clientId: "client-a", workspaceId: "workspace-a" };
const B = { clientId: "client-b", workspaceId: "workspace-a" };
const C = { clientId: "client-c", workspaceId: "workspace-a" };
const OTHER = { clientId: "client-z", workspaceId: "workspace-z" };

describe("in-process task coordinator", () => {
  it("creates workspace-visible logical tasks and lists only the current workspace", () => {
    const ids = ["coord-1", "coord-2"];
    const runtime = createTaskRuntime({ coordinationId: () => ids.shift() ?? "unexpected" });

    const first = runtime.create(A, "Review patch", "Inspect the patch and report findings.");
    expect(first).toMatchObject({
      kind: "coordination",
      taskId: "coord-1",
      state: "available",
      createdByClientId: "client-a"
    });
    expect(runtime.get(B, "coord-1")).toEqual(first);
    expect(runtime.list(B)).toEqual([first]);
    expect(runtime.list(OTHER)).toEqual([]);

    runtime.create(OTHER, "Other workspace", "Do not leak this task.");
    expect(runtime.list(A).map((task) => task.taskId)).toEqual(["coord-1"]);
    expect(() => runtime.get(A, "coord-2")).toThrowError(
      expect.objectContaining({ code: "task_not_found" })
    );
  });

  it("gives exactly one claimant ownership and supports release then reclaim", async () => {
    const runtime = createTaskRuntime({ coordinationId: () => "coord-claim" });
    runtime.create(A, "Claim me", "Exactly one client should own this work.");

    const [left, right] = await Promise.allSettled([
      Promise.resolve().then(() => runtime.claim(B, "coord-claim")),
      Promise.resolve().then(() => runtime.claim(C, "coord-claim"))
    ]);
    const fulfilled = [left, right].filter((entry) => entry.status === "fulfilled");
    const rejected = [left, right].filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "task_already_claimed"
    });

    const winner =
      left.status === "fulfilled"
        ? left.value.claimedBy
        : right.status === "fulfilled"
          ? right.value.claimedBy
          : undefined;
    expect(winner).toBeDefined();
    const winnerActor = winner === B.clientId ? B : C;
    const loserActor = winner === B.clientId ? C : B;

    expect(() => runtime.release(loserActor, "coord-claim")).toThrowError(
      expect.objectContaining({ code: "task_forbidden" })
    );
    const released = runtime.release(winnerActor, "coord-claim");
    expect(released.state).toBe("available");
    expect("claimedBy" in released).toBe(false);
    expect(runtime.claim(loserActor, "coord-claim")).toMatchObject({
      state: "claimed",
      claimedBy: loserActor.clientId
    });
  });

  it("allows only the claimant to complete/fail and keeps terminal state immutable", () => {
    const ids = ["coord-complete", "coord-fail"];
    const runtime = createTaskRuntime({ coordinationId: () => ids.shift() ?? "unexpected" });

    runtime.create(A, "Complete", "Complete this task.");
    runtime.claim(B, "coord-complete");
    expect(() => runtime.complete(C, "coord-complete", "nope")).toThrowError(
      expect.objectContaining({ code: "task_forbidden" })
    );
    expect(runtime.complete(B, "coord-complete", "done")).toMatchObject({
      state: "completed",
      result: "done"
    });
    expect(() => runtime.claim(C, "coord-complete")).toThrowError(
      expect.objectContaining({ code: "task_invalid_state" })
    );

    runtime.create(A, "Fail", "Fail this task.");
    runtime.claim(C, "coord-fail");
    expect(runtime.fail(C, "coord-fail", "blocked")).toMatchObject({
      state: "failed",
      failure: "blocked"
    });
    expect(() => runtime.release(C, "coord-fail")).toThrowError(
      expect.objectContaining({ code: "task_invalid_state" })
    );
  });

  it("lets only the creator cancel available or claimed work and enforces payload/count bounds", async () => {
    const ids = ["coord-cancel", "coord-next"];
    const runtime = createTaskRuntime({
      coordinationId: () => ids.shift() ?? "unexpected",
      maxCoordinationTasks: 1
    });
    runtime.create(A, "Cancelable", "Creator owns cancellation.");
    runtime.claim(B, "coord-cancel");

    await expect(runtime.cancel(B, "coord-cancel")).rejects.toMatchObject({
      code: "task_forbidden"
    });
    await expect(runtime.cancel(A, "coord-cancel")).resolves.toMatchObject({
      state: "cancelled",
      claimedBy: "client-b"
    });
    await expect(runtime.cancel(A, "coord-cancel")).resolves.toMatchObject({
      state: "cancelled"
    });

    expect(runtime.create(A, "Second", "Terminal history is pruned for capacity.")).toMatchObject({
      taskId: "coord-next",
      state: "available"
    });

    const payloadRuntime = createTaskRuntime({ coordinationId: () => "payload" });
    expect(() => payloadRuntime.create(A, "x".repeat(257), "instructions")).toThrowError(
      expect.objectContaining({ code: "task_payload_too_large" })
    );
    expect(() => payloadRuntime.create(A, "ok", "x".repeat(64 * 1024 + 1))).toThrowError(
      expect.objectContaining({ code: "task_payload_too_large" })
    );
  });

  it("prunes only the oldest terminal coordination record and preserves active work", async () => {
    const ids = ["completed", "failed", "active", "replacement", "overflow"];
    let tick = 0;
    const runtime = createTaskRuntime({
      coordinationId: () => ids.shift() ?? "unexpected",
      maxCoordinationTasks: 3,
      now: () => new Date(1_700_000_000_000 + tick++ * 1_000)
    });

    runtime.create(A, "Completed", "terminal one");
    runtime.claim(B, "completed");
    runtime.complete(B, "completed", "done");

    runtime.create(A, "Failed", "terminal two");
    runtime.claim(C, "failed");
    runtime.fail(C, "failed", "blocked");

    runtime.create(A, "Active", "must survive pruning");
    expect(runtime.create(A, "Replacement", "evicts oldest terminal")).toMatchObject({
      taskId: "replacement"
    });
    expect(() => runtime.get(A, "completed")).toThrowError(
      expect.objectContaining({ code: "task_not_found" })
    );
    expect(runtime.get(A, "failed")).toMatchObject({ state: "failed" });
    expect(runtime.get(A, "active")).toMatchObject({ state: "available" });

    runtime.claim(B, "replacement");
    expect(runtime.create(A, "Overflow", "evicts the remaining terminal task")).toMatchObject({
      taskId: "overflow",
      state: "available"
    });
    expect(() => runtime.get(A, "failed")).toThrowError(
      expect.objectContaining({ code: "task_not_found" })
    );
    expect(() => runtime.create(A, "Final", "all retained tasks are now active")).toThrowError(
      expect.objectContaining({ code: "task_capacity" })
    );
  });

  it("keeps task.wait runner-only and fails loud for coordination tasks", async () => {
    const runtime = createTaskRuntime({ coordinationId: () => "coord-wait" });
    runtime.create(A, "No wait", "Coordination MVP uses get/list, not wait.");
    await expect(runtime.wait(A, "coord-wait", { timeoutMs: 10 })).rejects.toMatchObject({
      code: "task_invalid_state"
    });
  });
});
