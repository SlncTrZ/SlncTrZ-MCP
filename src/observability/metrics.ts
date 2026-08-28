/**
 * Privacy-bounded process-local operational metrics.
 *
 * Metric names are fixed and no API accepts labels, paths, client identifiers, tool names,
 * provider names, request arguments, or result content.
 */

export type SupervisorMetricState =
  | "declared"
  | "starting"
  | "ready"
  | "degraded"
  | "restarting"
  | "quarantined"
  | "stopped"
  | "failed";

export interface MetricsSnapshot {
  readonly requestActive: number;
  readonly requestQueued: number;
  readonly toolCallsTotal: number;
  readonly toolErrorsTotal: number;
  readonly toolLatencyP50Ms: number;
  readonly toolLatencyP95Ms: number;
  readonly toolLatencyP99Ms: number;
  readonly outputTruncationsTotal: number;
  readonly authFailuresTotal: number;
  readonly extensionRestartsTotal: number;
  readonly extensionQuarantinesTotal: number;
  readonly policyReloadLastDurationMs: number;
  readonly residentMemoryBytes: number;
  readonly cpuUserMicroseconds: number;
  readonly cpuSystemMicroseconds: number;
}

export interface MetricsRegistry {
  toolStarted(): void;
  toolFinished(outcome: {
    readonly error: boolean;
    readonly durationMs: number;
    readonly truncated?: boolean;
  }): void;
  queueChanged(delta: 1 | -1): void;
  authFailed(): void;
  supervisorTransition(from: SupervisorMetricState, to: SupervisorMetricState): void;
  policyReloadCompleted(durationMs: number): void;
  snapshot(): Readonly<MetricsSnapshot>;
}

function requireMeasurement(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative`);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export function createMetricsRegistry(
  options: { readonly maxLatencySamples?: number } = {}
): MetricsRegistry {
  const maxLatencySamples = options.maxLatencySamples ?? 1_024;
  if (!Number.isSafeInteger(maxLatencySamples) || maxLatencySamples < 1) {
    throw new Error("Metric latency sample capacity must be a positive safe integer");
  }

  let requestActive = 0;
  let requestQueued = 0;
  let toolCallsTotal = 0;
  let toolErrorsTotal = 0;
  let outputTruncationsTotal = 0;
  let authFailuresTotal = 0;
  let extensionRestartsTotal = 0;
  let extensionQuarantinesTotal = 0;
  let policyReloadLastDurationMs = 0;
  const latencySamples: number[] = [];

  return Object.freeze({
    toolStarted(): void {
      requestActive += 1;
      toolCallsTotal += 1;
    },
    toolFinished(outcome: {
      readonly error: boolean;
      readonly durationMs: number;
      readonly truncated?: boolean;
    }): void {
      requireMeasurement(outcome.durationMs, "Tool duration");
      if (requestActive < 1) throw new Error("Tool completion has no active invocation");
      requestActive -= 1;
      if (outcome.error) toolErrorsTotal += 1;
      if (outcome.truncated === true) outputTruncationsTotal += 1;
      if (latencySamples.length === maxLatencySamples) latencySamples.shift();
      latencySamples.push(outcome.durationMs);
    },
    queueChanged(delta: 1 | -1): void {
      const next = requestQueued + delta;
      if (next < 0) throw new Error("Queued request gauge cannot be negative");
      requestQueued = next;
    },
    authFailed(): void {
      authFailuresTotal += 1;
    },
    supervisorTransition(from: SupervisorMetricState, to: SupervisorMetricState): void {
      if (from === to) return;
      if (to === "restarting") extensionRestartsTotal += 1;
      if (to === "quarantined") extensionQuarantinesTotal += 1;
    },
    policyReloadCompleted(durationMs: number): void {
      requireMeasurement(durationMs, "Policy reload duration");
      policyReloadLastDurationMs = durationMs;
    },
    snapshot(): Readonly<MetricsSnapshot> {
      const sorted = [...latencySamples].sort((left, right) => left - right);
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      return Object.freeze({
        requestActive,
        requestQueued,
        toolCallsTotal,
        toolErrorsTotal,
        toolLatencyP50Ms: percentile(sorted, 0.5),
        toolLatencyP95Ms: percentile(sorted, 0.95),
        toolLatencyP99Ms: percentile(sorted, 0.99),
        outputTruncationsTotal,
        authFailuresTotal,
        extensionRestartsTotal,
        extensionQuarantinesTotal,
        policyReloadLastDurationMs,
        residentMemoryBytes: memory.rss,
        cpuUserMicroseconds: cpu.user,
        cpuSystemMicroseconds: cpu.system
      });
    }
  });
}
