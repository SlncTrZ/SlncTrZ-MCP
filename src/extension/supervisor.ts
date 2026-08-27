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
  const queue: QueueEntry[] = [];
  let activeCall = false;

  const transition = (to: SupervisorState): void => {
    if (!canTransition(state, to)) {
      throw new Error(`Illegal supervisor transition ${state} -> ${to}`);
    }
    state = to;
  };

  const rejectQueue = (): void => {
    for (const entry of queue.splice(0)) {
      entry.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });

  const run = async (entry: QueueEntry): Promise<void> => {
    const controller = new AbortController();
    const caller = entry.options.signal;
    const linkAbort = (): void => controller.abort();
    const timeoutHit = { value: false };
    const onTimer = (): void => {
      timeoutHit.value = true;
      controller.abort();
    };
    caller?.addEventListener("abort", linkAbort, { once: true });
    const timer = setTimeout(onTimer, requestTimeoutMs);
    timer.unref();
    try {
      const result = await adapter.callTool(entry.toolId, entry.args, {
        signal: controller.signal
      });
      entry.resolve(result);
    } catch (error) {
      if (error instanceof AdapterError) {
        entry.resolve({ isError: true, truncated: false, text: error.code });
        // A transient provider failure is a crash; schedule a restart (budgeted).
        if (state === "ready" || state === "degraded") {
          void scheduleRestart();
        }
        return;
      }
      if (timeoutHit.value) {
        entry.resolve({ isError: true, truncated: false, text: "provider_timeout" });
        return;
      }
      entry.reject(error);
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", linkAbort);
      activeCall = false;
      drain();
    }
  };

  const scheduleRestart = (): Promise<void> => {
    if (restarting !== undefined) return restarting;
    restarting = (async () => {
      transition("restarting");
      restartAttempts += 1;
      if (restartAttempts > maxRestarts) {
        transition("quarantined");
        rejectQueue();
        return;
      }
      await sleep(backoffBaseMs + Math.floor(Math.random() * backoffJitterMs));
      if (state === "stopped") return;
      transition("starting");
      try {
        await adapter.start();
        if (state === "starting") transition("ready");
      } catch {
        if (state === "starting") {
          transition("quarantined");
          rejectQueue();
        }
      } finally {
        restarting = undefined;
      }
    })();
    return restarting;
  };

  const drain = (): void => {
    if (activeCall) return;
    const next = queue.shift();
    if (next === undefined) return;
    activeCall = true;
    void run(next);
  };

  const enqueue = (entry: QueueEntry): void => {
    if (queue.length >= maxQueue) {
      entry.reject(new AdapterError("queue_overflow", "queue_overflow"));
      return;
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
      try {
        await Promise.race([
          adapter.start(),
          sleep(startupTimeoutMs).then(() => {
            throw new AdapterError("provider_timeout", "provider_timeout");
          })
        ]);
      } catch (error) {
        transition("failed");
        rejectQueue();
        throw error;
      }
      if (state === "starting") transition("ready");
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
      if (state !== "ready") {
        return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      }
      return new Promise<ExtensionCallResult>((resolve, reject) => {
        enqueue({ resolve, reject, toolId, args, options: callOptions });
      });
    },

    async stop(): Promise<void> {
      rejectQueue();
      await adapter.stop();
      transition("stopped");
    },

    health(): AdapterHealth {
      return adapter.health();
    }
  };
}
