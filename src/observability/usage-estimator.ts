/**
 * Usage Estimator - stable model-neutral token approximation for gateway traffic.
 * Wing: observability | Topic: usage-telemetry | Updated: 2026-09-11
 */

export const USAGE_ESTIMATOR_ID = "utf8-bytes-v1";
export const ESTIMATED_BYTES_PER_TOKEN = 4;

export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("Usage bytes must be a non-negative safe integer");
  }
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
