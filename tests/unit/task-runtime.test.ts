import { describe, expect, it } from "vitest";
import type { ExecResult, ManagedRunCommandHandle } from "../../src/kernel/exec.js";
import {
  createTaskRuntime,
  type RunnerTaskActor,
  type TaskRuntimeError
} from "../../src/task/runtime.js";

const ACTOR: RunnerTaskActor = { clientId: "client-a", workspaceId: "workspace-a" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    commandId: "/bin/test",
    commandClass: "execute",
    argv: [],
    cwd: ".",
    envKeys: ["PATH"],
    applied: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides
  };
}

function handle() {
  const completion = deferred<ExecResult>();
  let cancelCalls = 0;
  const managed: ManagedRunCommandHandle = {
    cancel() {
      cancelCalls += 1;
      completion.resolve(result({ exitCode: null, signal: "SIGTERM", cancelled: true }));
    },
    completion: completion.promise
  };
  return { managed, completion, cancelCalls: () => cancelCalls };
}

describe("in-process task runtime", () => {
  it("tracks a managed process from running to completed", async () => {
    const runtime = createTaskRuntime({ id: () => "task-1" });
    const process = handle();

    const started = await runtime.start(ACTOR, "policy-1", async () => process.managed);
    expect(started).toMatchObject({
      taskId: "task-1",
      createdByClientId: "client-a",
      workspaceId: "workspace-a",
      state: "running"
    });

    process.completion.resolve(result({ stdout: "done\n" }));
    const waited = await runtime.wait(ACTOR, "task-1", { timeoutMs: 1_000 });

    expect(waited.waitTimedOut).toBe(false);
    expect(waited.task.state).toBe("completed");
    expect(waited.task.result?.stdout).toBe("done\n");
  });

  it("maps non-zero, timeout, and explicit cancellation to distinct terminal states", async () => {
    const ids = ["failed", "timed", "cancelled"];
    const runtime = createTaskRuntime({ id: () => ids.shift() ?? "unexpected" });

    const failed = handle();
    await runtime.start(ACTOR, "policy-1", async () => failed.managed);
    failed.completion.resolve(result({ exitCode: 7 }));
    expect((await runtime.wait(ACTOR, "failed", { timeoutMs: 1_000 })).task.state).toBe("failed");

    const timed = handle();
    await runtime.start(ACTOR, "policy-1", async () => timed.managed);
    timed.completion.resolve(result({ exitCode: null, signal: "SIGTERM", timedOut: true }));
    expect((await runtime.wait(ACTOR, "timed", { timeoutMs: 1_000 })).task.state).toBe("timed_out");

    const cancelled = handle();
    await runtime.start(ACTOR, "policy-1", async () => cancelled.managed);
    const cancelledTask = await runtime.cancel(ACTOR, "cancelled");
    expect(cancelledTask.state).toBe("cancelled");
    expect(cancelled.cancelCalls()).toBe(1);
  });

  it("times out or aborts a wait without cancelling the underlying task", async () => {
    const runtime = createTaskRuntime({ id: () => "task-wait" });
    const process = handle();
    await runtime.start(ACTOR, "policy-1", async () => process.managed);

    const timed = await runtime.wait(ACTOR, "task-wait", { timeoutMs: 5 });
    expect(timed.waitTimedOut).toBe(true);
    expect(timed.task.state).toBe("running");
    expect(process.cancelCalls()).toBe(0);

    const controller = new AbortController();
    const wait = runtime.wait(ACTOR, "task-wait", {
      timeoutMs: 1_000,
      signal: controller.signal
    });
    controller.abort();

    await expect(wait).rejects.toMatchObject({
      code: "task_wait_cancelled"
    } satisfies Partial<TaskRuntimeError>);
    expect(runtime.get(ACTOR, "task-wait").state).toBe("running");
    expect(process.cancelCalls()).toBe(0);

    process.completion.resolve(result());
    await runtime.wait(ACTOR, "task-wait", { timeoutMs: 1_000 });
  });

  it("shutdown is idempotent, cancels active runners, and rejects new work", async () => {
    const ids = ["one", "two"];
    const runtime = createTaskRuntime({
      id: () => ids.shift() ?? "unexpected",
      coordinationId: () => "coord"
    });
    const first = handle();
    await runtime.start(ACTOR, "policy-1", async () => first.managed);

    const left = runtime.shutdown({ timeoutMs: 1_000 });
    const right = runtime.shutdown({ timeoutMs: 1_000 });
    expect(left).toBe(right);
    await expect(left).resolves.toBeUndefined();
    expect(first.cancelCalls()).toBe(1);
    expect(runtime.get(ACTOR, "one")).toMatchObject({ state: "cancelled" });
    await expect(
      runtime.start(ACTOR, "policy-1", async () => handle().managed)
    ).rejects.toMatchObject({ code: "task_invalid_state" });
    expect(() => runtime.create(ACTOR, "Nope", "Runtime is stopping.")).toThrowError(
      expect.objectContaining({ code: "task_invalid_state" })
    );
  });

  it("enforces creator/workspace isolation and active-task capacity", async () => {
    const ids = ["one", "two"];
    const runtime = createTaskRuntime({
      id: () => ids.shift() ?? "unexpected",
      maxActiveTasks: 1,
      maxActiveTasksPerClient: 1,
      maxRetainedTasks: 2
    });
    const first = handle();
    await runtime.start(ACTOR, "policy-1", async () => first.managed);

    expect(() =>
      runtime.get({ clientId: "client-b", workspaceId: "workspace-a" }, "one")
    ).toThrowError(expect.objectContaining({ code: "task_forbidden" }));
    expect(() =>
      runtime.get({ clientId: "client-a", workspaceId: "workspace-b" }, "one")
    ).toThrowError(expect.objectContaining({ code: "task_not_found" }));

    await expect(
      runtime.start(ACTOR, "policy-1", async () => handle().managed)
    ).rejects.toMatchObject({ code: "task_capacity" });

    first.completion.resolve(result());
    await runtime.wait(ACTOR, "one", { timeoutMs: 1_000 });

    const second = handle();
    await expect(
      runtime.start(ACTOR, "policy-1", async () => second.managed)
    ).resolves.toMatchObject({
      taskId: "two",
      state: "running"
    });
    second.completion.resolve(result());
    await runtime.wait(ACTOR, "two", { timeoutMs: 1_000 });
  });
});
