import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  startRunCommand,
  type ExecResult,
  type ManagedRunCommandHandle
} from "../../src/kernel/exec.js";
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

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // Child has not written its PID yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("late launch did not write PID");
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`late launched process ${pid} survived cancellation`);
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

  it("waits for a pending launch and cancels it when shutdown begins", async () => {
    const runtime = createTaskRuntime({ id: () => "pending-launch" });
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    const late = handle();
    const starting = runtime.start(ACTOR, "policy-1", async () => {
      entered.resolve(undefined);
      await release.promise;
      return late.managed;
    });
    await entered.promise;

    let shutdownResolved = false;
    const shuttingDown = runtime.shutdown({ timeoutMs: 1_000 }).then(() => {
      shutdownResolved = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(shutdownResolved).toBe(false);

    release.resolve(undefined);
    await expect(shuttingDown).resolves.toBeUndefined();
    await expect(starting).resolves.toMatchObject({ state: "cancelled" });
    expect(late.cancelCalls()).toBe(1);
    expect(runtime.get(ACTOR, "pending-launch")).toMatchObject({ state: "cancelled" });
  });

  it("settles shutdown when a pending launch rejects", async () => {
    const runtime = createTaskRuntime({ id: () => "rejected-launch" });
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    const starting = runtime.start(ACTOR, "policy-1", async () => {
      entered.resolve(undefined);
      await release.promise;
      throw new Error("launch_failed");
    });
    await entered.promise;
    const shuttingDown = runtime.shutdown({ timeoutMs: 1_000 });
    release.resolve(undefined);

    await expect(starting).rejects.toThrow("launch_failed");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(() => runtime.get(ACTOR, "rejected-launch")).toThrowError(
      expect.objectContaining({ code: "task_not_found" })
    );
  });

  it("self-cancels a launch that resolves after the shutdown deadline", async () => {
    const runtime = createTaskRuntime({ id: () => "late-launch" });
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    const late = handle();
    const starting = runtime.start(ACTOR, "policy-1", async () => {
      entered.resolve(undefined);
      await release.promise;
      return late.managed;
    });
    await entered.promise;

    await expect(runtime.shutdown({ timeoutMs: 20 })).resolves.toBeUndefined();
    expect(late.cancelCalls()).toBe(0);
    release.resolve(undefined);

    await expect(starting).resolves.toMatchObject({ state: "cancelled" });
    expect(late.cancelCalls()).toBe(1);
    expect(runtime.get(ACTOR, "late-launch")).toMatchObject({ state: "cancelled" });
  });

  it("reaps a real process launched only after the shutdown deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-task-late-launch-"));
    try {
      const pidFile = join(root, "late.pid");
      const runtime = createTaskRuntime({ id: () => "late-real" });
      const entered = deferred<undefined>();
      const release = deferred<undefined>();
      const starting = runtime.start(ACTOR, "policy-1", async () => {
        entered.resolve(undefined);
        await release.promise;
        const managed = await startRunCommand(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`
          ],
          root,
          { timeoutMs: 10_000 }
        );
        await waitForPid(pidFile);
        return managed;
      });
      await entered.promise;

      await expect(runtime.shutdown({ timeoutMs: 20 })).resolves.toBeUndefined();
      release.resolve(undefined);
      const pid = await waitForPid(pidFile);
      await expect(starting).resolves.toMatchObject({ state: "cancelled" });
      await expect(expectProcessGone(pid)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
