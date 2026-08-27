# ADR-019: Scoped developer access and sandbox escalation criteria

> Status: Accepted
> Date: 2026-08-27
> Owners: SlncTrZ

## Context

The gateway may be used by AI web clients for repository development when a dedicated
coding agent is unavailable. That requires more authority than inspection, but a
permanent unrestricted shell would defeat the policy and audit boundaries.

## Decision

- Developer access is a policy-selected workspace/profile composition.
- Phase 3.1 execution remains operator-authored fixed commands; no shell, free-form
  argv, arbitrary binary, inherited environment, or implicit workspace is introduced.
- Policy changes expanding roots, profiles, bindings, or commands remain risk-increasing
  and require the approval boundary.
- Reload remains an explicit internal API. No watcher, public MCP reload tool, owner CLI,
  or control-plane UI is claimed or implemented by this ADR.
- The deployment baseline is a non-root service account plus explicit OS-level filesystem
  restrictions. A full runtime sandbox is deferred.
- A sandbox design/review gate is mandatory before free-form execution, untrusted code,
  broad network access, or multi-tenant operation.

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

Review Developer Profile policy changes against Phase 4 approval tests. Before enabling
any sandbox-triggering execution class, add a dedicated ADR, adversarial tests, and
platform-specific runtime evidence.
