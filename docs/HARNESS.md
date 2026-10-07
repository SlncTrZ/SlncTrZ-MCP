# Agent Harness & Skills

How SlncTrZ-MCP delivers global working instructions and progressive agent skills.

---

## 1. Harness Configuration

- Default instructions root: `<stateRoot>/harness/`.
- Override location using environment variable: `SLNCTRZ_HARNESS_ROOT`.

---

## 2. Context Lifecycle

1. Agent calls `context.bootstrap` to receive the Product Agent Harness and skills index.
2. The gateway creates an active session context `slnctrzContext` valid for four hours.
3. Successful mutations emit `operationExecuted` events to track verified progress.

---

## 3. Background Task Cancellation

- Terminate hanging or redundant background tasks via `task.cancel`.
- The gateway immediately releases child processes and associated execution buffers.
