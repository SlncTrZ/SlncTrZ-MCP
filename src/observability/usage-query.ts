/** Read-only query contract for owner usage telemetry. */

import { USAGE_ESTIMATOR_ID } from "./usage-estimator.js";

export const USAGE_RANGES = ["24h", "7d", "30d", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export function parseUsageRange(value: string | null | undefined): UsageRange {
  const normalized = value ?? "24h";
  if ((USAGE_RANGES as readonly string[]).includes(normalized)) return normalized as UsageRange;
  throw new Error("invalid_usage_range");
}

export interface UsageSummary {
  readonly available: true;
  readonly range: UsageRange;
  readonly estimatorId: string;
  readonly calls: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedTotalTokens: number;
}

export interface UsageTimeseriesPoint {
  readonly bucket: string;
  readonly deliveredEstimatedTokens: number;
  readonly avoidedEstimatedTokens: number;
}

export interface UsageToolBreakdown {
  readonly toolId: string;
  readonly calls: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedTotalTokens: number;
}

export interface UsageSavings {
  readonly available: true;
  readonly range: UsageRange;
  readonly estimatorId: string;
  readonly contexts: number;
  readonly potentialEagerEstimatedTokens: number;
  readonly disclosedEstimatedTokens: number;
  readonly avoidedEstimatedTokens: number;
  readonly reductionPercent: number;
}

export interface UsageReader {
  summary(range: UsageRange): UsageSummary;
  timeseries(range: UsageRange): readonly UsageTimeseriesPoint[];
  tools(range: UsageRange): readonly UsageToolBreakdown[];
  savings(range: UsageRange): UsageSavings;
}

export function emptyUsageSavings(range: UsageRange): UsageSavings {
  return {
    available: true,
    range,
    estimatorId: USAGE_ESTIMATOR_ID,
    contexts: 0,
    potentialEagerEstimatedTokens: 0,
    disclosedEstimatedTokens: 0,
    avoidedEstimatedTokens: 0,
    reductionPercent: 0
  };
}
