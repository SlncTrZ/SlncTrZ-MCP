import { describe, expect, it } from "vitest";
import { createExecutionGuard, type ExecutionError } from "../../src/kernel/execution.js";

describe("kernel execution guard", () => {
  it("fails immediately when cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => createExecutionGuard({ signal: controller.signal }).checkpoint()).toThrowError(
      expect.objectContaining({ code: "cancelled" }) as ExecutionError
    );
  });

  it("fails after its deadline", () => {
    let now = 0;
    const guard = createExecutionGuard({ timeoutMs: 2, now: () => now });
    guard.checkpoint();
    now = 2;

    expect(() => guard.checkpoint()).toThrowError(
      expect.objectContaining({ code: "timeout" }) as ExecutionError
    );
  });

  it("rejects invalid timeout values", () => {
    expect(() => createExecutionGuard({ timeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "timeout" }) as ExecutionError
    );
  });
});
