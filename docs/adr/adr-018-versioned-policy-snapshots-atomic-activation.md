# ADR-018: Versioned immutable policy snapshots and atomic activation

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Phase 3 authorized each kernel capability against one startup-built snapshot. That is not
enough for a live gateway: operators need to change workspaces, bindings, profiles and
roots without a restart, and a reload must never leave a partially-applied policy. The
reference behavior (PLAN Phase 4, ARCHITECTURE §4.7) therefore replaces the startup-only
snapshot with immutable, versioned snapshots compiled from a typed JSON document, and
makes activation all-or-nothing.

The following forces are at play:

- Implicit default-root or first-workspace fallback must not grant anything.
- Config is data only: no code, interpolation, shell expansion, or secrets.
- A request must observe exactly one snapshot; a reload must not produce hybrid state.
- An invalid candidate must have zero partial effect and emit a secret-free rejection.
- Risk increases (broadening access) must not silently apply without an approver.

## Decision

The gateway loads one operator-owned absolute JSON policy file (`SLNCTRZ_POLICY_FILE`)
and compiles it into a versioned, deeply immutable `ActivePolicySnapshot`.

- **Absent file = deny-all:** with no `SLNCTRZ_POLICY_FILE`, the active snapshot has no
  workspaces, so authenticated clients see only `core.ping`. No environment-root fallback.
- **Schema versioning:** `schemaVersion: 1`; every workspace and binding object is strict
  and bounded (128 workspaces, 128 bindings, 32 workspace IDs per binding, 16 profiles
  per workspace). Duplicate workspace/client/profile/binding IDs are rejected.
- **Snapshot hashing:** a canonical SHA-256 of the sorted normalized content provides a
  deterministic 16-hex version. Internal paths/argv/env may contribute to the hash but
  never to audit output.
- **Selection:** after bearer authentication and selector validation
  (`X-SlncTrZ-Workspace` / `X-SlncTrZ-Profile`) the request captures one snapshot and
  resolves one workspace bound to that principal. Missing/unknown/unauthorized selectors
  return 403 `workspace_denied` without constructing an MCP server. No default/current
  directory/home fallback.
- **Profile ceilings:** `read-only` = `core.read` + `core.search`; `minimal` = those plus
  `core.write`, `core.edit`, `core.exec`; `custom` = explicit capabilities only. Profiles
  never fabricate absent roots or commands; a missing profile never selects the broadest.
- **All-or-nothing activation:** a reload builds the candidate fully off to the side
  (read -> parse -> semantic validate -> canonicalize -> compile -> freeze) and only then
  replaces one private reference synchronously. A failed candidate preserves the exact
  prior object and version.
- **Atomic reload store:** `PolicySnapshotStore.capture()` returns the stable reference;
  `reload()` serializes with one mutex. A concurrent caller receives `reload_in_progress`
  and does not queue. Reloads never mutate the existing snapshot, workspace, profile,
  map, or command definitions.
- **Failed-reload retention:** a candidate that fails to load, parse, validate, compile or
  freeze leaves the active snapshot untouched; the reload result reports the failure code.
- **Approval boundary:** a risk-increasing reload (adds a workspace/binding/profile/
  capability, broadens a read/write/exec root or child PATH/fixed environment, or removes
  a deny) defers to an approval hook. The default hook is `unavailable`, so such a reload
  returns `approval_required` and retains the prior snapshot. Access reductions and
  metadata-only rotations activate without approval. Nothing auto-approves based on
  caller, locality, ownership, or an environment flag.
- **Decision audit:** each startup compile and reload attempt emits exactly one
  secret-free `PolicyAuditEvent` (versions, counts, risk flag, result). A sink failure
  never undoes an already-completed activation.

On-disk policy is never read in a request or tool path. The policy file, exec roots and
command registries are operator-controlled and must not be writable by the gateway
identity, workspaces, clients, or extensions.

**Out of scope (explicitly deferred):** filesystem watch, debounced reload, control-plane
UI or HTTP reload route, extension gateway, a live multi-process/distributed reload API,
partial workspace merge, in-place mutation, and Windows exec / network sandbox / extension
isolation claims.
