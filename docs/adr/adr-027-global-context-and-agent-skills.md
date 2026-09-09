# ADR-027: Global coding context and progressive Agent Skills

> Status: Accepted
> Date: 2026-09-09
> Supersedes: ADR-009's requirement to enumerate every instruction source manually

## Decision

The owner-approved v0.3.0 direction makes SlncTrZ a coding harness through MCP. Each installation
automatically discovers `<stateRoot>/harness/AGENTS.md` and `skills/*/SKILL.md`. An explicit
`SLNCTRZ_HARNESS_ROOT` may select another stable root. Installation seeds defaults once and keeps
owner edits outside versioned release binaries. Global-only operation is fully supported.

Project instructions and project skills are optional. `context.bootstrap` accepts an authorized
projectRoot and adds root AGENTS.md plus `.agents/skills/` and `skills/` discovery within it.
It does not scan arbitrary home directories or implement nested directory inheritance.

Bootstrap delivers product guidance, sourced instructions and skill metadata. Skills follow
catalog → SKILL.md activation → resources on demand. The model chooses relevance; the gateway
does deterministic discovery, validation and reading. No bulk skill-body injection occurs.

The product runtime requires an opaque context receipt before dispatching ordinary tools. It is
bound to authenticated client, workspace, policy version and instruction/catalog revision, with
bounded in-memory lifetime. Both a tool argument and namespaced MCP request metadata are supported.
Receipt validation never replaces authorization or grants new file/command/provider authority.

The transport is stateless; a receipt identifies an explicit work context, not a host conversation.
The host must deliver context to its model and maintain it across compaction. The gateway cannot
guarantee comprehension or absolute adherence. Diagnostics, bootstrap, context release and owned
task cancellation remain possible without a valid current receipt.

Context reads reuse the hardened filesystem reader with additional no-symlink checks and bounded
discovery. Global skill resources are exposed only through their dedicated reader, not by widening
general Paths. Unknown/invalid instructions fail visibly; invalid individual skills have diagnostics.

## Consequences

- Global preferences work across projects without repetitive per-repo configuration.
- Existing clients must perform bootstrap after upgrading to v0.3.0. Preflight failures do not
  execute the requested operation; arbitrary execution failures are not automatically retryable.
- Editable content is context, not system/security policy. Kernel/Auth/Policy remain authoritative.
- Provider extensibility is reused; no separate coding-extension SDK is required.
- Headless coding agents can manage receipts through MCP metadata while chat clients use arguments.

## Verification

Unit and authenticated legacy/modern MCP tests cover all three disclosure tiers, global-only and
optional project operation, principal isolation, stale/expired receipts, restart behavior, file
containment and byte limits, invalid YAML, installer preservation and rejection before side effects.
Release acceptance additionally requires the packaged runtime and native platform gates.
