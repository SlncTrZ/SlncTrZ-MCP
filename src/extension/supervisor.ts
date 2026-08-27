/**
 * Extension Supervisor — lifecycle state machine for one isolated provider.
 * Wing: extension | Topic: supervisor | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 2.
 *
 * The supervisor owns the state machine and resource bounds for one provider adapter; it
 * never executes provider logic itself. Startup/readiness and request timeouts, a bounded
 * per-provider queue, cancellation propagation, graceful stop, exponential backoff plus
 * jitter, a finite restart budget and quarantine all live here. An adapter error maps to a
 * stable outcome without leaking command paths, output, or credentials.
 *
 * Request timeout is hard-bound and races the adapter, so an adapter that ignores the
 * abort signal (or never resolves) cannot wedge the active slot or the queue. A caller
 * abort on a queued entry rejects it immediately without dispatching. Stop() aborts a
 * pending start so no illegal transition or unhandled rejection remains.
 */

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

function canTransition(from: SupervisorState, to: SupervisorState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

interface QueueEntry {
  resolve: (r: ExtensionCallResult) => void;
  reject: (e: unknown) => void;
  toolId: string;
  args: unknown;
  options: AdapterCallOptions;
  removed: boolean;
  onQueuedAbort?: () => void;
}

type CallOutcome =
  | { readonly kind: "ok"; readonly result: ExtensionCallResult }
  | { readonly kind: "timeout" }
  | { readonly kind: "adapter"; readonly code: AdapterError["code"] }
  | { readonly kind: "error"; readonly error: unknown };

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
  const queue: QueueEntry[] = [];
  let activeCall: QueueEntry | undefined;

  const transition = (to: SupervisorState): void => {
    if (!canTransition(state, to)) {
      throw new Error(`Illegal supervisor transition ${state} -> ${to}`);
    }
    state = to;
  };

  const rejectEntry = (entry: QueueEntry, code: AdapterError["code"]): void => {
    if (entry.removed) return;
    entry.removed = true;
    entry.reject(new AdapterError(code, code));
  };

  const removeFromQueue = (entry: QueueEntry): void => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const rejectQueued = (code: AdapterError["code"]): void => {
    for (const entry of [...queue]) {
      if (entry.removed) continue;
      rejectEntry(entry, code);
    }
    queue.length = 0;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });

  const settleActive = (): void => {
    activeCall = undefined;
    drain();
  };

  const run = (entry: QueueEntry): void => {
    const controller = new AbortController();
    const caller = entry.options.signal;
    const linkAbort = (): void => controller.abort();
    caller?.addEventListener("abort", linkAbort, { once: true });

    let settled = false;
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref();

    const outcomePromise: Promise<CallOutcome> = Promise.race([
      adapter
        .callTool(entry.toolId, entry.args, { signal: controller.signal })
        .then((result) => ({ kind: "ok", result }) as CallOutcome)
        .catch((error: unknown) =>
          error instanceof AdapterError
            ? ({ kind: "adapter", code: error.code } as CallOutcome)
            : ({ kind: "error", error } as CallOutcome)
        ),
      new Promise<CallOutcome>((resolve) => {
        const onTimer = (): void => resolve({ kind: "timeout" });
        const timerId = setTimeout(onTimer, requestTimeoutMs);
        timerId.unref();
      })
    ]);

    void outcomePromise.then((outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", linkAbort);
      if (outcome.kind === "timeout") {
        entry.resolve({ isError: true, truncated: false, text: "provider_timeout" });
        settleActive();
        return;
      }
      if (outcome.kind === "ok") {
        entry.resolve(outcome.result);
        settleActive();
        return;
      }
      if (outcome.kind === "adapter") {
        entry.resolve({ isError: true, truncated: false, text: outcome.code });
        if (state === "ready" || state === "degraded") {
          void scheduleRestart();
        }
        settleActive();
        return;
      }
      entry.reject(outcome.error);
      settleActive();
    });
  };

  const scheduleRestart = async (): Promise<void> => {
    if (restarting !== undefined) return;
    restarting = (async () => {
      transition("restarting");
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
        await adapter.start();
        if (state === "starting") transition("ready");
      } catch {
        // A failed restart attempt either retries (while budget remains) or quarantines.
        if (state === "starting") {
          await scheduleRestart();
        }
      } finally {
        restarting = undefined;
      }
    })();
    return restarting;
  };

  const drain = (): void => {
    if (activeCall !== undefined) return;
    if (state !== "ready" && state !== "degraded") return;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || next.removed) continue;
      if (next.options.signal?.aborted === true) {
        rejectEntry(next, "provider_unavailable");
        continue;
      }
      next.onQueuedAbort?.();
      activeCall = next;
      run(next);
      return;
    }
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
      // onQueuedAbort is only a cleanup hook (drop the listener) used at dispatch time;
      // the separate abort listener rejects the entry. This split avoids re-entrancy.
      const onAbort = (): void => {
        removeFromQueue(entry);
        rejectEntry(entry, "provider_unavailable");
      };
      entry.onQueuedAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    queue.push(entry);
    drain();
  };

  return {
    get state() {
      return state;
    },

    async start(): Promise<void> {
      transition("starting");
      let rejectStart: ((error: unknown) => void) | undefined;
      const startAborted = new Promise<never>((_, reject) => {
        rejectStart = reject;
      });
      abortStart = (): void =>
        rejectStart?.(new AdapterError("provider_unavailable", "provider_unavailable"));
      try {
        await Promise.race([
          adapter.start(),
          sleep(startupTimeoutMs).then(() => {
            throw new AdapterError("provider_timeout", "provider_timeout");
          }),
          startAborted
        ]);
        if (state === "starting") transition("ready");
      } catch (error) {
        // stop() may already have moved state to "stopped"; only transition if still starting.
        if (state === "starting") transition("failed");
        rejectQueued("provider_unavailable");
        throw error;
      } finally {
        abortStart = undefined;
      }
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      if (state !== "ready" && state !== "degraded") {
        throw new AdapterError("provider_unavailable", "provider_unavailable");
      }
      return adapter.listTools();
    },

    invoke(
      toolId: string,
      args: unknown,
      callOptions: AdapterCallOptions = {}
    ): Promise<ExtensionCallResult> {
      if (state !== "ready" && state !== "degraded") {
        return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      }
      return new Promise<ExtensionCallResult>((resolve, reject) => {
        enqueue({
          resolve,
          reject,
          toolId,
          args,
          options: callOptions,
          removed: false
        });
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      abortStart?.();
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
