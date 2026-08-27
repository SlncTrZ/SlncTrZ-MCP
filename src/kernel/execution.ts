/**
 * Kernel Execution Guard — shared timeout and cancellation checkpoints.
 * Wing: kernel | Topic: execution-contract | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3 shared timeout/cancellation contract and THREAT_MODEL §4.
 */

export const DEFAULT_KERNEL_TIMEOUT_MS = 5_000;

export type ExecutionErrorCode = "cancelled" | "timeout";

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
  }
}

export interface KernelExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface ExecutionGuard {
  readonly checkpoint: () => void;
}

/** Create a monotonic-enough request guard for bounded kernel operations. */
export function createExecutionGuard(options: KernelExecutionOptions = {}): ExecutionGuard {
  const timeoutMs = options.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ExecutionError("timeout", "timeoutMs must be a positive safe integer");
  }

  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  return {
    checkpoint: () => {
      if (options.signal?.aborted === true) {
        throw new ExecutionError("cancelled", "Operation cancelled");
      }
      if (now() >= deadline) {
        throw new ExecutionError("timeout", "Operation timed out");
      }
    }
  };
}
