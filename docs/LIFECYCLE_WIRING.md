# Lifecycle Wiring & Architecture

The durable operation ledger in `src/lifecycle/operation-ledger.ts` is intentionally unwired.
It imports no gateway runtime, registers no tools and does not manage live CAD applications.
This is a foundation contract and proposed integration plan.

## 1. Implemented Foundation

- Append-only JSONL with file sync before acknowledged append.
- Bounded sanitization of known sensitive keys and bearer-style values.
- get/history/list/load for operation records.
- Identity comparison using PID, creationIdentity and optional session/generation.

Sanitization replaces known sensitive values with redaction markers; it is not a generic
secret detector. Never pass arbitrary credentials in detail. Identity comparison only works
when the future controller obtains a trustworthy observed identity; the ledger itself
does not inspect the OS, adopt a process or stop one.

## 2. Operation Record Model

| Field       | Contract                                                         |
| ----------- | ---------------------------------------------------------------- |
| action      | ensure or stop                                                   |
| state       | requested, in_progress, ready, blocked, partial, failed, stopped |
| identity    | PID plus creationIdentity; optional session/generation           |
| detail      | Bounded sanitized object/array                                   |
| operationId | Caller-owned operation identity for append/history lookup        |

The ledger does not supply a workflow state machine, durable Task Coordinator or execution
controller. See the module/tests for load and malformed-record behavior.

## 3. Proposed Execution Controller Wiring

1. Choose a private managed path such as `<stateRoot>/lifecycle/operations.jsonl`.
   This path is not provisioned by the current gateway.
2. Record intent before dispatch; update records after observing each operation outcome.
3. On restart, observe real process identity and reconcile requested/in-progress operations.
   Fail closed on PID reuse, stale epoch, ambiguous ownership or unavailable observation.
4. Implement ownership-safe stop and native application/provider readiness separately.
5. Gate integration on crash/restart, concurrent ensure/stop, partial failure and redaction tests.

Existing `lifecycle-intent.json` is an owner-mutation recovery mechanism, distinct from this
ledger. Runner/Coordinator remain in-memory. Proposed CAD/CDT consumers require their own
implementation and native acceptance.

See [Architecture](../ARCHITECTURE.md), [Plan](../PLAN.md) and
[Release Acceptance](RELEASE_ACCEPTANCE.md).
