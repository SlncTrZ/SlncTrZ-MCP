/**
 * Usage Telemetry Types - passive, metadata-only gateway accounting.
 * Wing: observability | Topic: usage-telemetry | Updated: 2026-09-11
 */

export type UsageRequestKind = "initialize" | "tools_list" | "tools_call" | "other";

export interface UsageTrafficEvent {
  readonly timestamp: string;
  readonly workspaceId: string;
  readonly requestKind: UsageRequestKind;
  readonly toolId?: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly durationMs: number;
}

export interface HarnessUsageContextStart {
  readonly timestamp: string;
  readonly contextKey: string;
  readonly workspaceId: string;
  readonly potentialEagerBytes: number;
  readonly disclosedBytes: number;
  readonly potentialEagerEstimatedTokens: number;
  readonly disclosedEstimatedTokens: number;
}

export interface HarnessUsageDisclosure {
  readonly timestamp: string;
  readonly contextKey: string;
  readonly additionalBytes: number;
  readonly additionalEstimatedTokens: number;
}

export interface UsageObserver {
  traffic(event: UsageTrafficEvent): void;
  harnessContextStarted(event: HarnessUsageContextStart): void;
  harnessDisclosed(event: HarnessUsageDisclosure): void;
}

export const NOOP_USAGE_OBSERVER: UsageObserver = Object.freeze({
  traffic: () => undefined,
  harnessContextStarted: () => undefined,
  harnessDisclosed: () => undefined
});

export function createSafeUsageObserver(
  target: UsageObserver,
  onError?: (error: unknown) => void
): UsageObserver {
  const invoke = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      onError?.(error);
    }
  };
  return Object.freeze({
    traffic(event: UsageTrafficEvent) {
      invoke(() => target.traffic(event));
    },
    harnessContextStarted(event: HarnessUsageContextStart) {
      invoke(() => target.harnessContextStarted(event));
    },
    harnessDisclosed(event: HarnessUsageDisclosure) {
      invoke(() => target.harnessDisclosed(event));
    }
  });
}
