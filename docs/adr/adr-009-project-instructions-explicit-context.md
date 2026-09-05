# ADR-009: Project instructions are explicit context, not a security mechanism

> Status: Accepted
> Date: 2026-08-28
> Owners: SlncTrZ

## Context

Projects commonly contain user-, workspace-, and directory-level guidance. Implicit
discovery or system-prompt injection would make filesystem content appear authoritative,
hide provenance from clients, and create unbounded path, secret, and context-cost risks.
PLAN Phase 6 and ARCHITECTURE §4.12 require useful project context without creating a
second authorization channel.

## Decision

Instruction sources are declared only in the operator-owned workspace policy. A declaration
may name bounded absolute user files, workspace-relative files, and directory-local
basenames, together with source-count, per-file, and total-context byte limits. The gateway
does not scan the home directory or infer undeclared sources.

Resolution is deterministic: user files, workspace files, then directory-local files from
the deepest requested directory toward the workspace root. Workspace and directory reads
reuse the hardened filesystem boundary; user files use equivalent no-follow, opened-handle,
strict-UTF-8, byte-bound, secret-deny, and path-redaction controls. Files are either loaded
whole or referenced; instruction content is never partially injected.

For an authenticated, authorized workspace exchange, MCP exposes a provenance-only
`slnctrz://context/index` resource and an explicit `project-context` prompt. Prompt
content is returned with role `user` and an untrusted-context notice. It is never
automatically injected or returned as a system message. Instruction text cannot grant a
kernel capability, extension grant, profile, workspace, or policy exception.

Adding or reordering instruction sources, or increasing a context budget, is a
risk-increasing policy change and requires the existing approval hook. Removing sources or
reducing budgets does not. Absolute user paths and raw filesystem errors are not
client-visible.

Optional one-time onboarding state is deferred. This decision does not claim protection
from model-level prompt injection, Windows runtime evidence, or automatic client-side
context consumption.

## Consequences

- **Positive:** Clients receive deterministic, bounded project guidance with inspectable
  provenance while authorization remains exclusively in the immutable policy snapshot.
- **Negative / costs:** Operators must enumerate sources and clients must explicitly
  request content; whole-file budgeting may reference a useful file rather than load part
  of it.
- **Risks and mitigations:** Instruction content remains attacker-controlled model input.
  User-role delivery, an explicit warning, provenance, bounded reads, hard secret denial,
  and approval-gated widening preserve the context/authority boundary.

## Alternatives considered

- **Implicit home/workspace scanning:** rejected because it expands filesystem authority
  without an operator declaration and makes discovery non-deterministic.
- **Automatic system-prompt injection:** rejected because project text is not product or
  administrator policy.
- **Instruction-defined capabilities:** rejected because Policy Engine is the single
  authorization source.
- **Partial text truncation:** rejected because it can change instruction meaning;
  deterministic whole-file reference is safer.

## Verification

Linux Node 22.23.2 and Node 24.19.0 run the full repository typecheck, lint, format,
test, and build gates. Acceptance tests cover precedence, hash changes, budgets,
missing/malformed/oversized/symlink cases, secret and traversal denial, absolute-path
redaction, cross-workspace isolation, authenticated MCP provenance/prompt behavior, and
malicious instruction text that attempts to grant `core.exec`. Windows evidence is
deferred and not claimed.
