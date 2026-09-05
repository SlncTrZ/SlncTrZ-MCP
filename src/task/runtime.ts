/** In-process managed task runner. Persistence and cross-gateway recovery are intentionally absent. */

import { randomUUID } from "node:crypto";
import { ExecError, type ExecResult, type ManagedRunCommandHandle } from "../kernel/exec.js";

export const DEFAULT_MAX_ACTIVE_RUNNER_TASKS = 32;
export const DEFAULT_MAX_ACTIVE_RUNNER_TASKS_PER_CLIENT = 8;
export const DEFAULT_MAX_RETAINED_RUNNER_TASKS = 256;
export const HARD_MAX_TASK_WAIT_MS = 60_000;
export const DEFAULT_MAX_COORDINATION_TASKS = 256;
export const DEFAULT_TASK_RUNTIME_SHUTDOWN_TIMEOUT_MS = 5_000;
export const HARD_MAX_TASK_TITLE_CHARS = 256;
export const HARD_MAX_TASK_INSTRUCTIONS_BYTES = 64 * 1024;
export const HARD_MAX_TASK_RESULT_BYTES = 64 * 1024;

export type RunnerTaskState = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface RunnerTaskActor {
  readonly clientId: string;
  readonly workspaceId: string;
}

export interface RunnerTaskSnapshot {
  readonly kind: "runner";
  readonly taskId: string;
  readonly workspaceId: string;
  readonly createdByClientId: string;
  readonly policyVersion: string;
  readonly state: RunnerTaskState;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly result?: ExecResult;
  readonly failureCode?: string;
}

export interface RunnerTaskWaitResult {
  readonly task: RunnerTaskSnapshot;
  readonly waitTimedOut: boolean;
}

export type CoordinationTaskState = "available" | "claimed" | "completed" | "failed" | "cancelled";

export interface CoordinationTaskSnapshot {
  readonly kind: "coordination";
  readonly taskId: string;
  readonly workspaceId: string;
  readonly createdByClientId: string;
  readonly title: string;
  readonly instructions: string;
  readonly state: CoordinationTaskState;
  readonly claimedBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: string;
  readonly failure?: string;
}

export type TaskSnapshot = RunnerTaskSnapshot | CoordinationTaskSnapshot;

export type TaskRuntimeErrorCode =
  | "task_not_found"
  | "task_forbidden"
  | "task_capacity"
  | "task_wait_cancelled"
  | "task_invalid_wait"
  | "task_invalid_state"
  | "task_already_claimed"
  | "task_payload_too_large";

export class TaskRuntimeError extends Error {
  readonly code: TaskRuntimeErrorCode;

  constructor(code: TaskRuntimeErrorCode, message: string) {
    super(message);
    this.name = "TaskRuntimeError";
    this.code = code;
  }
}

interface MutableRunnerTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly createdByClientId: string;
  readonly policyVersion: string;
  state: RunnerTaskState;
  readonly createdAt: string;
  completedAt?: string;
  result?: ExecResult;
  failureCode?: string;
  handle?: ManagedRunCommandHandle;
  settled?: Promise<void>;
}

interface MutableCoordinationTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly createdByClientId: string;
  readonly title: string;
  readonly instructions: string;
  state: CoordinationTaskState;
  claimedBy?: string;
  readonly createdAt: string;
  updatedAt: string;
  result?: string;
  failure?: string;
}

export interface TaskRuntimeOptions {
  readonly maxActiveTasks?: number;
  readonly maxActiveTasksPerClient?: number;
  readonly maxRetainedTasks?: number;
  readonly maxCoordinationTasks?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly coordinationId?: () => string;
}

export interface TaskRuntime {
  start(
    actor: RunnerTaskActor,
    policyVersion: string,
    launch: () => Promise<ManagedRunCommandHandle>
  ): Promise<RunnerTaskSnapshot>;
  get(actor: RunnerTaskActor, taskId: string): TaskSnapshot;
  create(actor: RunnerTaskActor, title: string, instructions: string): CoordinationTaskSnapshot;
  list(actor: RunnerTaskActor): readonly CoordinationTaskSnapshot[];
  claim(actor: RunnerTaskActor, taskId: string): CoordinationTaskSnapshot;
  release(actor: RunnerTaskActor, taskId: string): CoordinationTaskSnapshot;
  complete(actor: RunnerTaskActor, taskId: string, result: string): CoordinationTaskSnapshot;
  fail(actor: RunnerTaskActor, taskId: string, failure: string): CoordinationTaskSnapshot;
  wait(
    actor: RunnerTaskActor,
    taskId: string,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }
  ): Promise<RunnerTaskWaitResult>;
  cancel(actor: RunnerTaskActor, taskId: string): Promise<TaskSnapshot>;
  shutdown(options?: { readonly timeoutMs?: number }): Promise<void>;
}

function validatePositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function copyExecResult(result: ExecResult): ExecResult {
  return Object.freeze({
    ...result,
    argv: Object.freeze([...result.argv]),
    envKeys: Object.freeze([...result.envKeys])
  });
}

function runnerSnapshot(task: MutableRunnerTask): RunnerTaskSnapshot {
  return Object.freeze({
    kind: "runner",
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    createdByClientId: task.createdByClientId,
    policyVersion: task.policyVersion,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.result === undefined ? {} : { result: copyExecResult(task.result) }),
    ...(task.failureCode === undefined ? {} : { failureCode: task.failureCode })
  });
}

function coordinationSnapshot(task: MutableCoordinationTask): CoordinationTaskSnapshot {
  return Object.freeze({
    kind: "coordination",
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    createdByClientId: task.createdByClientId,
    title: task.title,
    instructions: task.instructions,
    state: task.state,
    ...(task.claimedBy === undefined ? {} : { claimedBy: task.claimedBy }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.failure === undefined ? {} : { failure: task.failure })
  });
}

function stateFromResult(result: ExecResult): RunnerTaskState {
  if (result.timedOut) return "timed_out";
  if (result.cancelled) return "cancelled";
  return result.exitCode === 0 ? "completed" : "failed";
}

export function createTaskRuntime(options: TaskRuntimeOptions = {}): TaskRuntime {
  const maxActiveTasks = options.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_RUNNER_TASKS;
  const maxActiveTasksPerClient =
    options.maxActiveTasksPerClient ?? DEFAULT_MAX_ACTIVE_RUNNER_TASKS_PER_CLIENT;
  const maxRetainedTasks = options.maxRetainedTasks ?? DEFAULT_MAX_RETAINED_RUNNER_TASKS;
  const maxCoordinationTasks = options.maxCoordinationTasks ?? DEFAULT_MAX_COORDINATION_TASKS;
  validatePositiveBound(maxActiveTasks, "maxActiveTasks");
  validatePositiveBound(maxActiveTasksPerClient, "maxActiveTasksPerClient");
  validatePositiveBound(maxRetainedTasks, "maxRetainedTasks");
  validatePositiveBound(maxCoordinationTasks, "maxCoordinationTasks");
  if (maxActiveTasksPerClient > maxActiveTasks) {
    throw new RangeError("maxActiveTasksPerClient cannot exceed maxActiveTasks");
  }
  if (maxRetainedTasks < maxActiveTasks) {
    throw new RangeError("maxRetainedTasks cannot be lower than maxActiveTasks");
  }

  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const coordinationId = options.coordinationId ?? randomUUID;
  const runnerTasks = new Map<string, MutableRunnerTask>();
  const coordinationTasks = new Map<string, MutableCoordinationTask>();
  let accepting = true;
  let shutdownPromise: Promise<void> | undefined;

  const assertAccepting = (): void => {
    if (!accepting) {
      throw new TaskRuntimeError("task_invalid_state", "Task runtime is shutting down");
    }
  };

  const activeCount = (): number =>
    [...runnerTasks.values()].filter((task) => task.state === "running").length;

  const activeClientCount = (clientId: string): number =>
    [...runnerTasks.values()].filter(
      (task) => task.state === "running" && task.createdByClientId === clientId
    ).length;

  const pruneTerminalTasks = (): void => {
    if (runnerTasks.size < maxRetainedTasks) return;
    const terminal = [...runnerTasks.values()]
      .filter((task) => task.state !== "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const task of terminal) {
      if (runnerTasks.size < maxRetainedTasks) break;
      runnerTasks.delete(task.taskId);
    }
  };

  const pruneTerminalCoordinationTasks = (): void => {
    if (coordinationTasks.size < maxCoordinationTasks) return;
    const terminal = [...coordinationTasks.values()]
      .filter(
        (task) =>
          task.state === "completed" || task.state === "failed" || task.state === "cancelled"
      )
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.taskId.localeCompare(right.taskId)
      );
    for (const task of terminal) {
      if (coordinationTasks.size < maxCoordinationTasks) break;
      coordinationTasks.delete(task.taskId);
    }
  };

  const lookupRunner = (actor: RunnerTaskActor, taskId: string): MutableRunnerTask => {
    const task = runnerTasks.get(taskId);
    if (task === undefined || task.workspaceId !== actor.workspaceId) {
      throw new TaskRuntimeError("task_not_found", "Task was not found");
    }
    if (task.createdByClientId !== actor.clientId) {
      throw new TaskRuntimeError("task_forbidden", "Task belongs to another client");
    }
    return task;
  };

  const lookupCoordination = (actor: RunnerTaskActor, taskId: string): MutableCoordinationTask => {
    const task = coordinationTasks.get(taskId);
    if (task === undefined || task.workspaceId !== actor.workspaceId) {
      throw new TaskRuntimeError("task_not_found", "Task was not found");
    }
    return task;
  };

  const assertCoordinationText = (
    value: string,
    label: "title" | "instructions" | "result" | "failure"
  ): void => {
    if (value.length === 0) {
      throw new TaskRuntimeError("task_payload_too_large", `Task ${label} must not be empty`);
    }
    if (label === "title") {
      if (value.length > HARD_MAX_TASK_TITLE_CHARS) {
        throw new TaskRuntimeError(
          "task_payload_too_large",
          "Task title exceeds the supported limit"
        );
      }
      return;
    }
    const limit =
      label === "instructions" ? HARD_MAX_TASK_INSTRUCTIONS_BYTES : HARD_MAX_TASK_RESULT_BYTES;
    if (Buffer.byteLength(value, "utf8") > limit) {
      throw new TaskRuntimeError(
        "task_payload_too_large",
        `Task ${label} exceeds the supported limit`
      );
    }
  };

  const runtime: TaskRuntime = {
    async start(actor, policyVersion, launch) {
      assertAccepting();
      pruneTerminalTasks();
      if (runnerTasks.size >= maxRetainedTasks || activeCount() >= maxActiveTasks) {
        throw new TaskRuntimeError("task_capacity", "Runner task capacity is exhausted");
      }
      if (activeClientCount(actor.clientId) >= maxActiveTasksPerClient) {
        throw new TaskRuntimeError("task_capacity", "Client runner task capacity is exhausted");
      }

      const taskId = id();
      if (runnerTasks.has(taskId) || coordinationTasks.has(taskId)) {
        throw new Error("task_id_collision");
      }
      const task: MutableRunnerTask = {
        taskId,
        workspaceId: actor.workspaceId,
        createdByClientId: actor.clientId,
        policyVersion,
        state: "running",
        createdAt: now().toISOString()
      };
      runnerTasks.set(taskId, task);

      try {
        const handle = await launch();
        task.handle = handle;
        task.settled = handle.completion.then(
          (result) => {
            task.result = copyExecResult(result);
            task.state = stateFromResult(result);
            task.completedAt = now().toISOString();
          },
          (error: unknown) => {
            task.state = "failed";
            task.failureCode = error instanceof ExecError ? error.code : "execution_failed";
            task.completedAt = now().toISOString();
          }
        );
        return runnerSnapshot(task);
      } catch (error) {
        runnerTasks.delete(taskId);
        throw error;
      }
    },

    get(actor, taskId) {
      const runner = runnerTasks.get(taskId);
      if (runner !== undefined) return runnerSnapshot(lookupRunner(actor, taskId));
      return coordinationSnapshot(lookupCoordination(actor, taskId));
    },

    create(actor, title, instructions) {
      assertAccepting();
      assertCoordinationText(title, "title");
      assertCoordinationText(instructions, "instructions");
      pruneTerminalCoordinationTasks();
      if (coordinationTasks.size >= maxCoordinationTasks) {
        throw new TaskRuntimeError("task_capacity", "Coordination task capacity is exhausted");
      }
      const taskId = coordinationId();
      if (runnerTasks.has(taskId) || coordinationTasks.has(taskId)) {
        throw new Error("task_id_collision");
      }
      const timestamp = now().toISOString();
      const task: MutableCoordinationTask = {
        taskId,
        workspaceId: actor.workspaceId,
        createdByClientId: actor.clientId,
        title,
        instructions,
        state: "available",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      coordinationTasks.set(taskId, task);
      return coordinationSnapshot(task);
    },

    list(actor) {
      return Object.freeze(
        [...coordinationTasks.values()]
          .filter((task) => task.workspaceId === actor.workspaceId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map(coordinationSnapshot)
      );
    },

    claim(actor, taskId) {
      assertAccepting();
      const task = lookupCoordination(actor, taskId);
      if (task.state === "claimed") {
        if (task.claimedBy === actor.clientId) return coordinationSnapshot(task);
        throw new TaskRuntimeError("task_already_claimed", "Task is already claimed");
      }
      if (task.state !== "available") {
        throw new TaskRuntimeError("task_invalid_state", "Task is not available for claim");
      }
      task.state = "claimed";
      task.claimedBy = actor.clientId;
      task.updatedAt = now().toISOString();
      return coordinationSnapshot(task);
    },

    release(actor, taskId) {
      assertAccepting();
      const task = lookupCoordination(actor, taskId);
      if (task.state !== "claimed") {
        throw new TaskRuntimeError("task_invalid_state", "Task is not currently claimed");
      }
      if (task.claimedBy !== actor.clientId) {
        throw new TaskRuntimeError(
          "task_forbidden",
          "Only the current claimant may release the task"
        );
      }
      task.state = "available";
      delete task.claimedBy;
      task.updatedAt = now().toISOString();
      return coordinationSnapshot(task);
    },

    complete(actor, taskId, result) {
      assertAccepting();
      assertCoordinationText(result, "result");
      const task = lookupCoordination(actor, taskId);
      if (task.state !== "claimed") {
        throw new TaskRuntimeError("task_invalid_state", "Task is not currently claimed");
      }
      if (task.claimedBy !== actor.clientId) {
        throw new TaskRuntimeError(
          "task_forbidden",
          "Only the current claimant may complete the task"
        );
      }
      task.state = "completed";
      task.result = result;
      task.updatedAt = now().toISOString();
      return coordinationSnapshot(task);
    },

    fail(actor, taskId, failure) {
      assertAccepting();
      assertCoordinationText(failure, "failure");
      const task = lookupCoordination(actor, taskId);
      if (task.state !== "claimed") {
        throw new TaskRuntimeError("task_invalid_state", "Task is not currently claimed");
      }
      if (task.claimedBy !== actor.clientId) {
        throw new TaskRuntimeError("task_forbidden", "Only the current claimant may fail the task");
      }
      task.state = "failed";
      task.failure = failure;
      task.updatedAt = now().toISOString();
      return coordinationSnapshot(task);
    },

    async wait(actor, taskId, waitOptions = {}) {
      const timeoutMs = waitOptions.timeoutMs ?? HARD_MAX_TASK_WAIT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HARD_MAX_TASK_WAIT_MS) {
        throw new TaskRuntimeError(
          "task_invalid_wait",
          "Task wait timeout is outside the supported range"
        );
      }

      if (coordinationTasks.has(taskId)) {
        lookupCoordination(actor, taskId);
        throw new TaskRuntimeError(
          "task_invalid_state",
          "Coordination tasks do not support task.wait"
        );
      }
      const task = lookupRunner(actor, taskId);
      if (task.state !== "running" || task.settled === undefined) {
        return { task: runnerSnapshot(task), waitTimedOut: false };
      }

      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      try {
        const outcome = await Promise.race([
          task.settled.then(() => "settled" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
            timer.unref();
          }),
          new Promise<"aborted">((resolve) => {
            if (waitOptions.signal?.aborted === true) {
              resolve("aborted");
              return;
            }
            abortListener = () => resolve("aborted");
            waitOptions.signal?.addEventListener("abort", abortListener, { once: true });
          })
        ]);

        if (outcome === "aborted") {
          throw new TaskRuntimeError("task_wait_cancelled", "Task wait request was cancelled");
        }
        return { task: runnerSnapshot(task), waitTimedOut: outcome === "timeout" };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abortListener !== undefined) {
          waitOptions.signal?.removeEventListener("abort", abortListener);
        }
      }
    },

    async cancel(actor, taskId) {
      const runner = runnerTasks.get(taskId);
      if (runner !== undefined) {
        const task = lookupRunner(actor, taskId);
        if (task.state !== "running") return runnerSnapshot(task);
        task.handle?.cancel();
        await task.settled;
        return runnerSnapshot(task);
      }

      const task = lookupCoordination(actor, taskId);
      if (task.createdByClientId !== actor.clientId) {
        throw new TaskRuntimeError("task_forbidden", "Only the task creator may cancel the task");
      }
      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        return coordinationSnapshot(task);
      }
      task.state = "cancelled";
      task.updatedAt = now().toISOString();
      return coordinationSnapshot(task);
    },

    shutdown(shutdownOptions = {}) {
      if (shutdownPromise !== undefined) return shutdownPromise;
      accepting = false;
      const timeoutMs = shutdownOptions.timeoutMs ?? DEFAULT_TASK_RUNTIME_SHUTDOWN_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new RangeError("Task runtime shutdown timeout must be positive"));
      }
      shutdownPromise = (async () => {
        const running = [...runnerTasks.values()].filter((task) => task.state === "running");
        for (const task of running) task.handle?.cancel();
        const settlements = running
          .map((task) => task.settled)
          .filter((settled): settled is Promise<void> => settled !== undefined);
        if (settlements.length === 0) return;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.allSettled(settlements).then(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, timeoutMs);
              timer.unref();
            })
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    }
  };
  return Object.freeze(runtime);
}
