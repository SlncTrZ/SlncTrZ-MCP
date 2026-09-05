/**
 * Extension Supervisor — lifecycle state machine for one isolated provider.
 * Wing: extension | Topic: supervisor | Updated: 2026-08-27
 *
 * The supervisor owns the state machine and resource bounds for one provider adapter. A
 * request timeout races the adapter so an uncooperative adapter cannot wedge the queue;
 * cancellation is removed before dispatch; stop settles the active caller; and failed
 * restarts consume one finite budget before the provider is quarantined.
 */

import type { MetricsRegistry } from "../observability/metrics.js";
import {
  AdapterError,
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "./adapter.js";

export type SupervisorState =
  | "declared"
  | "starting"
  | "ready"
  | "degraded"
  | "restarting"
  | "quarantined"
  | "stopped"
  | "failed";

export interface ExtensionSupervisorOptions {
  readonly adapter: ExtensionAdapter;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxQueue?: number;
  readonly maxRestarts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffJitterMs?: number;
  readonly metrics?: MetricsRegistry;
}

const VALID_TRANSITIONS: Readonly<Record<SupervisorState, readonly SupervisorState[]>> = {
  declared: ["starting", "stopped"],
  starting: ["ready", "failed", "restarting", "stopped"],
  ready: ["degraded", "restarting", "stopped"],
  degraded: ["ready", "restarting", "stopped"],
  restarting: ["starting", "quarantined", "stopped"],
  quarantined: ["stopped"],
  stopped: [],
  failed: ["stopped"]
};

interface QueueEntry {
  resolve: (result: ExtensionCallResult) => void;
  reject: (error: unknown) => void;
  toolId: string;
  args: unknown;
  options: AdapterCallOptions;
  removed: boolean;
  removeQueuedAbort?: () => void;
}

type CallOutcome =
  | { readonly kind: "ok"; readonly result: ExtensionCallResult }
  | { readonly kind: "timeout" }
  | { readonly kind: "adapter"; readonly code: AdapterError["code"] }
  | { readonly kind: "error"; readonly error: unknown };

function isRunnable(state: SupervisorState): boolean {
  return state === "ready" || state === "degraded";
}

export function createExtensionSupervisor(options: ExtensionSupervisorOptions): {
  readonly state: SupervisorState;
  start(): Promise<void>;
  listTools(): Promise<readonly ExtensionToolInfo[]>;
  invoke(
    toolId: string,
    args: unknown,
    callOptions?: AdapterCallOptions
  ): Promise<ExtensionCallResult>;
  stop(): Promise<void>;
  health(): AdapterHealth;
} {
  const adapter = options.adapter;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxQueue = options.maxQueue ?? 16;
  const maxRestarts = options.maxRestarts ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 100;
  const backoffJitterMs = options.backoffJitterMs ?? 100;

  let state: SupervisorState = "declared";
  let restartAttempts = 0;
  let restarting: Promise<void> | undefined;
  let stopped = false;
  let abortStart: (() => void) | undefined;
  let activeCall: QueueEntry | undefined;
  let abortActive: (() => void) | undefined;
  const queue: QueueEntry[] = [];

  const transition = (to: SupervisorState): void => {
    if (!VALID_TRANSITIONS[state].includes(to)) {
      throw new Error(`Illegal supervisor transition ${state} -> ${to}`);
    }
    const from = state;
    state = to;
    options.metrics?.supervisorTransition(from, to);
  };

  const rejectEntry = (entry: QueueEntry, code: AdapterError["code"]): void => {
    if (entry.removed) return;
    entry.removed = true;
    entry.removeQueuedAbort?.();
    entry.reject(new AdapterError(code, code));
  };

  const rejectQueued = (code: AdapterError["code"]): void => {
    const rejected = queue.splice(0);
    for (const entry of rejected) {
      options.metrics?.queueChanged(-1);
      rejectEntry(entry, code);
    }
  };

  const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    });

  const withTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AdapterError("provider_timeout", "provider_timeout")),
        timeoutMs
      );
      timer.unref();
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });

  const drain = (): void => {
    if (activeCall !== undefined || !isRunnable(state)) return;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) continue;
      options.metrics?.queueChanged(-1);
      if (next.removed) continue;
      if (next.options.signal?.aborted === true) {
        rejectEntry(next, "provider_unavailable");
        continue;
      }
      next.removeQueuedAbort?.();
      activeCall = next;
      run(next);
      return;
    }
  };

  const settleActive = (entry: QueueEntry): void => {
    if (activeCall !== entry) return;
    activeCall = undefined;
    abortActive = undefined;
    drain();
  };

  const scheduleRestart = (): Promise<void> => {
    if (restarting !== undefined) return restarting;
    restarting = (async () => {
      transition("restarting");
      while (!stopped) {
        restartAttempts += 1;
        if (restartAttempts > maxRestarts) {
          transition("quarantined");
          rejectQueued("provider_unavailable");
          return;
        }
        await sleep(backoffBaseMs + Math.floor(Math.random() * backoffJitterMs));
        if (stopped) return;
        transition("starting");
        try {
          await withTimeout(adapter.start(), startupTimeoutMs);
          if (state === "starting") transition("ready");
          return;
        } catch {
          if (state !== "starting") return;
          transition("restarting");
        }
      }
    })().finally(() => {
      restarting = undefined;
    });
    return restarting;
  };

  const run = (entry: QueueEntry): void => {
    const controller = new AbortController();
    const caller = entry.options.signal;
    const linkAbort = (): void => controller.abort();
    caller?.addEventListener("abort", linkAbort, { once: true });

    let settleStopped: ((outcome: CallOutcome) => void) | undefined;
    const stoppedOutcome = new Promise<CallOutcome>((resolve) => {
      settleStopped = resolve;
    });
    abortActive = (): void => {
      controller.abort();
      settleStopped?.({ kind: "adapter", code: "provider_unavailable" });
    };

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<CallOutcome>((resolve) => {
      timeoutTimer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, requestTimeoutMs);
      timeoutTimer.unref();
    });

    const providerOutcome = adapter
      .callTool(entry.toolId, entry.args, { signal: controller.signal })
      .then((result) => ({ kind: "ok", result }) as CallOutcome)
      .catch((error: unknown) =>
        error instanceof AdapterError
          ? ({ kind: "adapter", code: error.code } as CallOutcome)
          : ({ kind: "error", error } as CallOutcome)
      );

    void Promise.race([providerOutcome, timeoutOutcome, stoppedOutcome]).then((outcome) => {
      clearTimeout(timeoutTimer);
      caller?.removeEventListener("abort", linkAbort);

      if (outcome.kind === "timeout") {
        entry.resolve({ isError: true, truncated: false, text: "provider_timeout" });
      } else if (outcome.kind === "ok") {
        entry.resolve(outcome.result);
      } else if (outcome.kind === "adapter") {
        entry.resolve({ isError: true, truncated: false, text: outcome.code });
        if (isRunnable(state)) void scheduleRestart();
      } else {
        entry.reject(outcome.error);
      }
      settleActive(entry);
    });
  };

  const enqueue = (entry: QueueEntry): void => {
    if (queue.length >= maxQueue) {
      rejectEntry(entry, "queue_overflow");
      return;
    }
    const signal = entry.options.signal;
    if (signal?.aborted === true) {
      rejectEntry(entry, "provider_unavailable");
      return;
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
          options.metrics?.queueChanged(-1);
        }
        rejectEntry(entry, "provider_unavailable");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeQueuedAbort = (): void => signal.removeEventListener("abort", onAbort);
    }
    queue.push(entry);
    options.metrics?.queueChanged(1);
    drain();
  };

  return {
    get state() {
      return state;
    },

    async start(): Promise<void> {
      transition("starting");
      let rejectStart: ((error: unknown) => void) | undefined;
      const stoppedStart = new Promise<never>((_, reject) => {
        rejectStart = reject;
      });
      abortStart = (): void =>
        rejectStart?.(new AdapterError("provider_unavailable", "provider_unavailable"));
      try {
        await Promise.race([withTimeout(adapter.start(), startupTimeoutMs), stoppedStart]);
        if (state === "starting") transition("ready");
      } catch (error) {
        if (state === "starting") transition("failed");
        rejectQueued("provider_unavailable");
        throw error;
      } finally {
        abortStart = undefined;
      }
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      if (!isRunnable(state)) {
        throw new AdapterError("provider_unavailable", "provider_unavailable");
      }
      return withTimeout(adapter.listTools(), requestTimeoutMs);
    },

    invoke(
      toolId: string,
      args: unknown,
      callOptions: AdapterCallOptions = {}
    ): Promise<ExtensionCallResult> {
      if (!isRunnable(state)) {
        return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      }
      return new Promise<ExtensionCallResult>((resolve, reject) => {
        enqueue({ resolve, reject, toolId, args, options: callOptions, removed: false });
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      abortStart?.();
      abortActive?.();
      rejectQueued("provider_unavailable");
      try {
        await adapter.stop();
      } finally {
        if (state !== "stopped") transition("stopped");
      }
    },

    health(): AdapterHealth {
      return adapter.health();
    }
  };
}
