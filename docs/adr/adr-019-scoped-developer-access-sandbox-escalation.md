# ADR-019: Scoped developer access and sandbox escalation criteria

> Status: Partially superseded by the v0.3.5 schema-v2 authority model
> Date: 2026-08-27
> Owners: SlncTrZ

> Current-contract note (2026-09-24): the historical workspace/profile/binding approval model below is no longer the active product contract. Current managed policy is schema v2: shared Paths plus `authorityMode` (Restricted or Autonomous). Owner-authenticated management surfaces persist a fully validated candidate and the runtime atomically swaps the active policy generation; failed candidates restore/retain prior durable and active state. `PolicySnapshotStore.reload()` has no separate `ownerApproved` flag and current `riskIncrease` audit metadata is always false. Restricted execution uses Paths + `command.json`; Autonomous mode follows the gateway OS-user authority. The sandbox escalation warning remains active.

## Context

The gateway may be used by AI web clients for repository development when a dedicated
coding agent is unavailable. That requires more authority than inspection, but a
permanent unrestricted shell would defeat the policy and audit boundaries.

## Historical Decision

- Developer access was modeled as a policy-selected workspace/profile composition.
- Phase 3.1 execution used operator-authored fixed commands.
- Policy changes expanding roots, profiles, bindings, or commands were treated as
  risk-increasing changes requiring a separate approval boundary.
- Reload was an explicit internal API with no owner mutation surface claimed by this ADR.
- The deployment baseline was a non-root service account plus OS-level restrictions.
- A sandbox design/review gate was required before free-form execution, untrusted code,
  broad network access, or multi-tenant operation.

## Current Decision

- Managed policy is schema v2: `paths[]` plus `authorityMode`.
- Restricted mode bounds filesystem work to configured Paths and bounds `core.exec` by
  Paths cwd plus the owner-managed command catalog.
- Autonomous mode intentionally follows the permissions of the gateway OS account.
- Owner-authenticated management surfaces are the approval boundary for policy mutations;
  there is no second `ownerApproved` boolean inside `PolicySnapshotStore`.
- Policy/provider reload still uses candidate-build-before-swap semantics; failed reloads
  do not partially activate.
- Restricted mode is not an OS sandbox. Authorizing a general-purpose shell/interpreter
  lets child processes exercise the gateway OS account's permissions.
- A separate sandbox design/review gate is still mandatory before claiming containment for
  untrusted code, broad network access, or multi-tenant operation.

## Consequences

- Positive: AI Web can perform bounded, auditable development work without a general shell.
- Positive: owner-controlled policy can broaden access deliberately and reversibly.
- Negative: fixed commands are less flexible than Codex/Claude Code style free-form CLI.
- Risk: OS service hardening is deployment work and must be documented per target.

## Alternatives considered

Opening arbitrary shell access now was rejected because it collapses command, path,
network, and credential boundaries. Building a Docker/VM sandbox now was deferred
because it adds cross-platform operational complexity before the system needs that
execution class.

## Verification

Verify schema-v2 policy mutation/rollback tests, atomic policy generation activation,
Restricted/Autonomous execution tests, and owner-surface authorization. Before claiming
sandbox containment for any execution class, add a dedicated ADR, adversarial tests, and
platform-specific runtime evidence.
