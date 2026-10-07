# Lifecycle Wiring & Architecture

Architecture and wiring specification for the durable Lifecycle Operation Ledger.

---

## 1. Overview

The Lifecycle Operation Ledger (`src/lifecycle/operation-ledger.ts`) provides append-only, fsync-backed, and secret-free persistence for multi-step agent actions and external CAD/CDT domain execution engines.

It guarantees:

- **Crash consistency**: JSONL records flushed to disk via `fsync` before acknowledgment.
- **Secret redaction**: Sensitive keys (passwords, tokens, credentials, private keys) are stripped before disk write.
- **Identity verification**: Controller identity checks (PID, creationIdentity, session, generation) verify that a restarted supervisor or execution engine reconciles actual process state before adopting prior operations.

---

## 2. Operation Record Model

- **Actions**: `ensure` (ensure desired state or process running), `stop` (terminate process or release resources).
- **States**: `requested`, `in_progress`, `ready`, `blocked`, `partial`, `failed`, `stopped`.
- **Payload Sanitization**: Recursive depth-bounded truncation and credential pattern masking.

---

## 3. Execution Controller Wiring Points

When wiring the future execution controller:

1. **Storage Path**: `<stateRoot>/lifecycle/operations.jsonl` under the managed state directory.
2. **Supervisor Integration**:
   - `append`: Call prior to dispatching process execution or lifecycle mutations.
   - `get` / `history`: Query active status and replay transition history.
   - `verifyOperationIdentity`: Ensure restarted controllers fail closed if observed process PID or epoch does not match the ledger record.
3. **Domain Engine Extension**: Supports planned downstream CAD providers (AutoCAD, SolidWorks, KiCAD) and CDT execution engines.
