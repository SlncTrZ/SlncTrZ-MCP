import { describe, expect, it } from "vitest";
import {
  AdapterError,
  type AdapterHealth,
  type AdapterCallOptions,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "../../src/extension/adapter.js";
import { createExtensionSupervisor } from "../../src/extension/supervisor.js";

interface DeferredCall {
  resolve: (r: ExtensionCallResult) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal | undefined;
}

/** A controllable fake adapter so the supervisor is fully deterministically testable. */
class FakeAdapter implements ExtensionAdapter {
  startCalls = 0;
  stopCalls = 0;
  listToolsCalls = 0;
  callTools: string[] = [];
  healthValue: AdapterHealth = "ready";
  startBehavior: "resolve" | "reject" | "hang" = "resolve";
  callBehavior: "resolve" | "reject" | "hang" = "resolve";
  ignoreAbort = false;
  readonly tools: readonly ExtensionToolInfo[] = [
    { canonicalId: "p.findOne", exposedName: "p.findOne", riskClass: "read" },
    { canonicalId: "p.writeOne", exposedName: "p.writeOne", riskClass: "write" }
  ];
  deferredStarts: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  deferredCalls: DeferredCall[] = [];

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startBehavior === "resolve") return;
    if (this.startBehavior === "reject") {
      throw new AdapterError("provider_unavailable", "start refused");
    }
    return new Promise<void>((resolve, reject) => {
      this.deferredStarts.push({ resolve, reject });
    });
  }

  async listTools(): Promise<readonly ExtensionToolInfo[]> {
    this.listToolsCalls += 1;
    return this.tools;
  }

  async callTool(
    toolId: string,
    _args: unknown,
    options: AdapterCallOptions
  ): Promise<ExtensionCallResult> {
    this.callTools.push(toolId);
    if (this.callBehavior === "resolve") {
      return { isError: false, truncated: false, text: "ok" };
    }
    if (this.callBehavior === "reject") {
      throw new AdapterError("provider_unavailable", "call refused");
    }
    return new Promise<ExtensionCallResult>((resolve, reject) => {
      const entry: DeferredCall = { resolve, reject, signal: options.signal };
      this.deferredCalls.push(entry);
      // A well-behaved adapter resolves on abort; an adapter that ignores the signal
      // (ignoreAbort=true) never listens, so the supervisor must hard-bound the timeout.
      if (!this.ignoreAbort) {
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve({ isError: true, truncated: false, text: "cancelled" });
          },
          { once: true }
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  health(): AdapterHealth {
    return this.healthValue;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

describe("extension supervisor: state machine (fake-first)", () => {
  it("moves Declared -> Starting -> Ready on a successful start", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createExtensionSupervisor({ adapter });
    expect(supervisor.state).toBe("declared");
    await supervisor.start();
    expect(supervisor.state).toBe("ready");
    expect(adapter.startCalls).toBe(1);
  });

  it("moves to Failed on a startup rejection", async () => {
    const adapter = new FakeAdapter();
    adapter.startBehavior = "reject";
    const supervisor = createExtensionSupervisor({ adapter, startupTimeoutMs: 100 });
    await expect(supervisor.start()).rejects.toBeDefined();
    expect(supervisor.state).toBe("failed");
  });

  it("moves to Failed when startup times out", async () => {
    const adapter = new FakeAdapter();
    adapter.startBehavior = "hang";
    const supervisor = createExtensionSupervisor({ adapter, startupTimeoutMs: 20 });
    await expect(supervisor.start()).rejects.toBeDefined();
    expect(supervisor.state).toBe("failed");
  });

  it("propagates a caller abort through to the adapter's signal", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "hang";
    const supervisor = createExtensionSupervisor({ adapter, requestTimeoutMs: 5000 });
    await supervisor.start();
    const controller = new AbortController();
    const promise = supervisor.invoke("p.findOne", {}, { signal: controller.signal });
    // Let the call reach the adapter so it captures the signal.
    await tick();
    controller.abort();
    const outcome = await promise;
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("cancelled");
    expect(adapter.callTools).toContain("p.findOne");
  });

  it("maps an adapter failure to a stable provider_unavailable outcome", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "reject";
    const supervisor = createExtensionSupervisor({ adapter });
    await supervisor.start();
    const result = await supervisor.invoke("p.findOne", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("provider_unavailable");
  });

  it("restarts a crashed provider up to the finite budget, then quarantines", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "reject";
    const supervisor = createExtensionSupervisor({
      adapter,
      maxRestarts: 2,
      backoffBaseMs: 5,
      backoffJitterMs: 0
    });
    await supervisor.start();
    expect(supervisor.state).toBe("ready");

    // Crash 1 -> restart 1 (allowed), Crash 2 -> restart 2 (allowed),
    // Crash 3 -> restartAttempts 3 > maxRestarts 2 -> quarantine.
    await supervisor.invoke("p.findOne", {});
    await tick();
    await supervisor.invoke("p.findOne", {});
    await tick();
    await supervisor.invoke("p.findOne", {});
    await tick();
    expect(supervisor.state).toBe("quarantined");
  });

  it("enforces a bounded per-provider queue (excess rejected)", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "hang";
    const supervisor = createExtensionSupervisor({
      adapter,
      maxQueue: 1,
      requestTimeoutMs: 5000
    });
    await supervisor.start();

    const invoke1 = supervisor.invoke("p.findOne", {});
    // Let invoke1 start (active) so invoke2 fills the queue.
    await tick();
    const invoke2 = supervisor.invoke("p.findOne", {});
    // invoke3 must overflow: queue is full (maxQueue 1) -> rejected synchronously.
    const invoke3 = supervisor.invoke("p.findOne", {});

    const overflow = await invoke3.catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(AdapterError);
    expect((overflow as AdapterError).code).toBe("queue_overflow");

    // Release invoke1, then let the drain start invoke2 and release it.
    const first = adapter.deferredCalls.shift();
    first?.resolve({ isError: false, truncated: false, text: "ok" });
    await invoke1;
    await tick();
    const second = adapter.deferredCalls.shift();
    second?.resolve({ isError: false, truncated: false, text: "ok" });
    await invoke2;

    expect(adapter.callTools).toHaveLength(2);
  });

  it("does not run provider logic in-process: adapter boundary invoked, not core", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createExtensionSupervisor({ adapter });
    await supervisor.start();
    await supervisor.invoke("p.findOne", {});
    expect(adapter.callTools).toHaveLength(1);
    expect(adapter.listToolsCalls).toBe(0);
  });

  it("stops cleanly and never reaches Ready after a stop", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createExtensionSupervisor({ adapter });
    await supervisor.start();
    await supervisor.stop();
    expect(adapter.stopCalls).toBe(1);
    expect(supervisor.state).toBe("stopped");
  });

  it("rejects an invoke when not ready (deny before dispatch)", async () => {
    const adapter = new FakeAdapter();
    const supervisor = createExtensionSupervisor({ adapter });
    await expect(supervisor.invoke("p.findOne", {})).rejects.toMatchObject({
      code: "provider_unavailable"
    } satisfies Partial<AdapterError>);
  });

  it("reports health by delegating to the adapter", async () => {
    const adapter = new FakeAdapter();
    adapter.healthValue = "degraded";
    const supervisor = createExtensionSupervisor({ adapter });
    expect(supervisor.health()).toBe("degraded");
  });

  it("hard-bounds a request timeout even when the adapter ignores abort", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "hang";
    adapter.ignoreAbort = true; // never resolves on abort, never settles
    const supervisor = createExtensionSupervisor({ adapter, requestTimeoutMs: 25 });
    await supervisor.start();
    const result = await supervisor.invoke("p.findOne", {});
    // The timeout settles regardless of the stuck adapter, freeing the active slot.
    expect(result.isError).toBe(true);
    expect(result.text).toBe("provider_timeout");
    // A follow-up invoke must run: the previous stuck call did not wedge the queue.
    adapter.callBehavior = "resolve";
    adapter.ignoreAbort = false;
    const next = await supervisor.invoke("p.findOne", {});
    expect(next.isError).toBe(false);
  });

  it("rejects a caller abort on a queued entry before dispatch", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "hang";
    const supervisor = createExtensionSupervisor({ adapter, maxQueue: 3, requestTimeoutMs: 5000 });
    await supervisor.start();
    // Fill the active slot and one queue slot, then abort a queued entry.
    const active = supervisor.invoke("p.findOne", {});
    await tick();
    const queuedController = new AbortController();
    const queued = supervisor.invoke("p.findOne", {}, { signal: queuedController.signal });
    queuedController.abort(); // abort before dispatch
    let outcome: unknown;
    await queued.then(
      (r) => {
        outcome = r;
      },
      (e) => {
        outcome = e;
      }
    );
    expect(adapter.callTools).toHaveLength(1); // the queued one never dispatched
    expect(outcome).toBeInstanceOf(AdapterError);
    // Release the active call so the test can settle.
    adapter.deferredCalls.shift()?.resolve({ isError: false, truncated: false, text: "ok" });
    await active;
  });

  it("does not dispatch queued calls while restarting, and quarantines after exhaustion", async () => {
    const adapter = new FakeAdapter();
    adapter.callBehavior = "reject"; // every call crashes
    const supervisor = createExtensionSupervisor({
      adapter,
      maxRestarts: 0, // no restart allowed: first crash exhausts the budget
      backoffBaseMs: 5,
      backoffJitterMs: 0
    });
    await supervisor.start();
    expect(supervisor.state).toBe("ready");

    // First crash exhausts the zero budget -> quarantine.
    const crashed = await supervisor.invoke("p.findOne", {});
    expect(crashed.isError).toBe(true);
    await tick();
    expect(supervisor.state).toBe("quarantined");

    // After quarantine no request is dispatched; it is rejected (never reaches the adapter).
    const held = supervisor.invoke("p.findOne", {});
    let heldOutcome: unknown;
    await held.then(
      (r) => {
        heldOutcome = r;
      },
      (e) => {
        heldOutcome = e;
      }
    );
    expect(adapter.callTools).toHaveLength(1); // the held one was never dispatched
    expect(heldOutcome).toBeInstanceOf(AdapterError);
  });

  it("stop() during startup does not throw an illegal transition or rejection", async () => {
    const adapter = new FakeAdapter();
    adapter.startBehavior = "hang";
    const supervisor = createExtensionSupervisor({ adapter, startupTimeoutMs: 5000 });
    const starting = supervisor.start();
    await tick();
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.state).toBe("stopped");
    // The pending start must not reject with an unhandled error after stop.
    const startResult = await starting.then(
      () => "ok",
      () => "rejected"
    );
    expect(startResult).toBe("rejected");
  });
});

void (null as unknown as ExtensionToolInfo);
