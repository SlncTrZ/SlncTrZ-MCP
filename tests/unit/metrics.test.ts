import { describe, expect, it } from "vitest";
import { createMetricsRegistry } from "../../src/observability/metrics.js";
import { observeToolInvocation } from "../../src/observability/tool-invocation.js";

describe("bounded operational metrics", () => {
  it("tracks active calls, errors, truncation and bounded latency percentiles", async () => {
    const metrics = createMetricsRegistry({ maxLatencySamples: 3 });
    metrics.toolStarted();
    metrics.toolFinished({ error: false, durationMs: 10 });
    metrics.toolStarted();
    metrics.toolFinished({ error: true, durationMs: 20, truncated: true });
    metrics.toolStarted();
    metrics.toolFinished({ error: false, durationMs: 30 });
    metrics.toolStarted();
    metrics.toolFinished({ error: false, durationMs: 40 });

    expect(metrics.snapshot()).toMatchObject({
      requestActive: 0,
      toolCallsTotal: 4,
      toolErrorsTotal: 1,
      outputTruncationsTotal: 1,
      toolLatencyP50Ms: 30,
      toolLatencyP95Ms: 40,
      toolLatencyP99Ms: 40
    });
  });

  it("uses deterministic ceiling-rank percentiles after exact-capacity eviction", () => {
    const metrics = createMetricsRegistry({ maxLatencySamples: 2 });
    for (const durationMs of [10, 20]) {
      metrics.toolStarted();
      metrics.toolFinished({ error: false, durationMs });
    }

    expect(metrics.snapshot()).toMatchObject({
      toolLatencyP50Ms: 10,
      toolLatencyP95Ms: 20,
      toolLatencyP99Ms: 20
    });

    metrics.toolStarted();
    metrics.toolFinished({ error: false, durationMs: 30 });

    expect(metrics.snapshot()).toMatchObject({
      toolCallsTotal: 3,
      toolLatencyP50Ms: 20,
      toolLatencyP95Ms: 30,
      toolLatencyP99Ms: 30
    });
  });

  it("records only real supervisor transitions and keeps queue depth balanced", () => {
    const metrics = createMetricsRegistry();
    metrics.queueChanged(1);
    metrics.queueChanged(1);
    metrics.queueChanged(-1);
    metrics.supervisorTransition("ready", "restarting");
    metrics.supervisorTransition("restarting", "starting");
    metrics.supervisorTransition("restarting", "quarantined");
    metrics.policyReloadCompleted(17);

    expect(metrics.snapshot()).toMatchObject({
      requestQueued: 1,
      extensionRestartsTotal: 1,
      extensionQuarantinesTotal: 1,
      policyReloadLastDurationMs: 17
    });
  });

  it("fails closed on invalid measurements and gauge underflow", () => {
    const metrics = createMetricsRegistry();
    expect(() => metrics.toolFinished({ error: false, durationMs: 1 })).toThrow();
    expect(() => metrics.queueChanged(-1)).toThrow();
    metrics.toolStarted();
    expect(() => metrics.toolFinished({ error: false, durationMs: Number.NaN })).toThrow();
    expect(() => createMetricsRegistry({ maxLatencySamples: 0 })).toThrow();
  });

  it("balances active calls for returned errors and thrown handlers", async () => {
    const metrics = createMetricsRegistry();
    await observeToolInvocation(metrics, async () => ({
      isError: true,
      structuredContent: { truncated: true }
    }));
    await expect(
      observeToolInvocation(metrics, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(metrics.snapshot()).toMatchObject({
      requestActive: 0,
      toolCallsTotal: 2,
      toolErrorsTotal: 2,
      outputTruncationsTotal: 1
    });
  });

  it("can be disabled without changing tool behavior", async () => {
    await expect(observeToolInvocation(undefined, async () => "ok")).resolves.toBe("ok");
  });
});
