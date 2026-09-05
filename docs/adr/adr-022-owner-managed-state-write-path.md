# ADR-022: Owner managed state write path under systemd hardening

> Status: Partially superseded for workspace filesystem hardening and standalone service packaging; retained for managed-state history
> Date: 2026-08-29
> Owners: SlncTrZ

## Supersession note

The original service-level read-only filesystem decision conflicts with the simplified product contract: a configured workspace Path must be writable/editable/executable immediately, and `Add Path` may authorize arbitrary user-writable locations dynamically. The service therefore no longer uses `ProtectSystem=strict` or `ProtectHome=read-only` as a second static workspace boundary. The current standalone System Install also uses the SEA launcher + explicit `/var/lib/slnctrz-mcp` state contract rather than the historical source/Node deployment assumptions. Workspace authority is enforced by authenticated policy, canonical path containment, secret-path denies, and the command catalog in Restricted mode; Autonomous mode follows runtime OS-user authority.

## Context

Phase 10 introduces the owner control plane, which persists managed state (the owned policy
file, installed skills, and the default agent harness) and performs policy mutation with
atomic writes. Prior phases ran a stateless gateway that read nothing and wrote nothing,
so the systemd unit could harden the whole filesystem as read-only (`ProtectSystem=strict`,
`ProtectHome=read-only`) with no writable path and still boot cleanly.

Phase 10's `ensureManagedStateLayout` writes the managed harness and creates the skills layout
during startup, and the owner mutation service atomically replaces the policy file. Under the
old hardening this boot-time write fails (`EROFS`) on a host with no granted writable path,
so the service would fail closed and crash-loop.

## Decision

- Keep `ProtectSystem=strict` and `ProtectHome=read-only`: the gateway still writes no arbitrary
  path and never writable home. Owner managed state is the single exception, and it lives in a
  dedicated systemd location rather than home or the working directory.
- Add `StateDirectory=slnctrz-mcp` to the `[Service]` section. systemd creates
  `/var/lib/slnctrz-mcp`, owned by the service user, as the one writable path under
  `ProtectSystem=strict`.
- Set `SLNCTRZ_STATE_ROOT=/var/lib/slnctrz-mcp` in the host runtime env file
  (`_runtime/gateway.env`). `readRuntimeConfig` defaults the state root to `~/.slnctrz-mcp`
  when the variable is absent, so the template documents both together.
- Policy mutation, the owned policy file, installed skills, and the default harness are written
  only under this state root. No commit makes home or an arbitrary path writable.

## Consequences

- **Positive:** home remains read-only; the managed state is isolated, routinely backed up, and
  inspected under `/var/lib`; systemd owns directory creation and ownership, so a state dir that
  already exists from a previous run is preserved.
- **Negative / costs:** the state location is no longer the implicit `~/.slnctrz-mcp` default; a
  deployment that omits `StateDirectory` while the state root is unset fails closed on startup
  rather than writing state silently.
- **Risks and mitigations:** a host with `StateDirectory` but no `SLNCTRZ_STATE_ROOT` would write
  to `~/.slnctrz-mcp` and hit `ProtectHome=read-only`; the template and this ADR pair the two
  settings to avoid split configuration.

## Alternatives considered

- **`ReadWritePaths=/home/<user>/.slnctrz-mcp`:** rejected — keeps managed state in home,
  requires pre-creating the directory, and is less idiomatic than `StateDirectory` residency
  under `/var/lib`.
- **Relax `ProtectHome` to writable:** rejected — breaks the invariant that the gateway cannot
  write to home.
- **Keep state in the working directory:** rejected — the working directory is in home
  (read-only) and would mix source with mutable state.

## Verification

- On 2026-08-29, deployed to a Linux runtime host: added `StateDirectory=slnctrz-mcp` to the unit
  and `SLNCTRZ_STATE_ROOT=/var/lib/slnctrz-mcp` to `_runtime/gateway.env`; `npm ci` and the
  TypeScript build passed; `systemd` restart verified `active (running)` with `NRestarts=0`,
  `/var/lib/slnctrz-mcp` created (`agent` + `skills`), public MCP returning `403` (default
  deny), control plane returning `401` (owner auth required), and no boot error in the journal.
