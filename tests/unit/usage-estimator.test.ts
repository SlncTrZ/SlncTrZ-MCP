import { describe, expect, it } from "vitest";
import {
  ESTIMATED_BYTES_PER_TOKEN,
  estimateTokensFromBytes,
  USAGE_ESTIMATOR_ID,
  utf8Bytes
} from "../../src/observability/usage-estimator.js";
import { createSafeUsageObserver } from "../../src/observability/usage-types.js";

describe("usage estimator", () => {
  it("keeps a deterministic versioned model-neutral estimate", () => {
    expect(USAGE_ESTIMATOR_ID).toBe("utf8-bytes-v1");
    expect(ESTIMATED_BYTES_PER_TOKEN).toBe(4);
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(1)).toBe(1);
    expect(estimateTokensFromBytes(4)).toBe(1);
    expect(estimateTokensFromBytes(5)).toBe(2);
    expect(utf8Bytes("hello")).toBe(5);
    expect(utf8Bytes("Xin chào 👋")).toBeGreaterThan("Xin chào 👋".length);
  });

  it("rejects invalid byte counts and isolates observer failures", () => {
    expect(() => estimateTokensFromBytes(-1)).toThrow(RangeError);
    const errors: unknown[] = [];
    const observer = createSafeUsageObserver(
      {
        traffic() {
          throw new Error("traffic failed");
        },
        harnessContextStarted() {
          throw new Error("harness start failed");
        },
        harnessDisclosed() {
          throw new Error("harness disclosure failed");
        }
      },
      (error) => errors.push(error)
    );
    expect(() =>
      observer.traffic({
        timestamp: new Date(0).toISOString(),
        workspaceId: "test",
        requestKind: "other",
        inputBytes: 0,
        outputBytes: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        durationMs: 0
      })
    ).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
