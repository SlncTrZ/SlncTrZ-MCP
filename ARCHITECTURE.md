# SlncTrZ-MCP Architecture

## North star

The runtime is built around one product flow:

```text
Authenticated client
→ active policy snapshot
→ selected autonomy level
→ core tools + enabled MCP tools
```

The owner manages a deliberately small surface:

```text
Autonomy
Paths
Commands
MCP Servers
```

Everything else is an internal safety/runtime mechanism.

## Public gateway

The public MCP gateway owns:

- OAuth authentication and dynamic client registration where required.
- request limits, host/origin validation and MCP protocol dispatch.
- `core.ping`, `core.read`, `core.search`, `core.write`, `core.edit`.
- `core.exec` on Windows and POSIX. Restricted mode uses `command.json`; autonomous mode uses the gateway process user authority.
- the in-process managed Task Runtime (`task.*`) when enabled.
- enabled MCP provider tools.

A principal is used for authentication and audit attribution only. It does not select workspace, profile, binding, or grant state.

## Product policy

Managed policy schema v2 is deliberately small:

```json
{
  "schemaVersion": 2,
  "paths": ["/home/user/project"],
  "authorityMode": "restricted"
}
```

Compilation derives one kernel snapshot:

```text
Paths
→ readRoots
→ writeRoots
→ runRoots
```

Capabilities derive from the snapshot and autonomy level. In restricted mode, file tools use Paths and `core.exec` requires a compiled command catalog. In autonomous mode, all core capabilities are available subject to the OS permissions of the gateway process.

Legacy schema-v1 workspace/profile/binding fields are accepted only at the parse boundary for one-way migration. They are not represented in the active runtime model.

## Filesystem kernel

The filesystem kernel preserves deterministic I/O guards in both modes. Restricted mode additionally applies policy boundaries:

- canonical containment under configured Paths;
- secret-path denial;
- symlink/race protection;
- bounded reads/searches;
- atomic writes;
- optimistic SHA-256 conflict checks for overwrite/edit.

`core.write` and `core.edit` apply when `dryRun` is omitted. `dryRun:true` explicitly requests preview.

## Exec

Execution has two policy paths:

```text
restricted → cwd inside Paths ∩ command.json rule match
autonomous → executable/cwd allowed by the gateway OS user token
```

Windows and POSIX use platform-native process execution. Time/output bounds, environment handling, cancellation/process-tree cleanup and metadata-only audit remain runtime guards rather than authorization boundaries.

Restricted mode is not an OS sandbox: if the owner authorizes a general-purpose shell or interpreter, that child process can exercise the permissions of the gateway OS user. This is an intentional owner-controlled capability, not a containment guarantee.

There is no second fixed-command registry or separate execution root.

## Managed Task Runtime

Task Runtime is gateway-lifetime, bounded and intentionally in-memory in the current product. It has two roles:

```text
Runner       task.start/get/wait/cancel
Coordinator  task.create/list/get/claim/release/complete/fail/cancel
```

Runner tasks reuse the same managed execution primitive and authorization path as `core.exec`; `task.start` never creates independent execution authority. Runner state is creator-private and workspace-bound. Request cancellation of `task.wait` does not control process lifetime; only explicit task cancellation does.

Coordinator tasks are logical work records, not executable authority. They are visible within the resolved workspace, use deterministic single-winner claim semantics, allow only the current claimant to release/complete/fail, and allow the creator to cancel. Coordination instructions/results remain data and cannot override Kernel/Auth/Policy.

Task IDs/state survive later MCP requests only while the same gateway process remains alive. Gateway restart clears Task Runtime state; no durable recovery, lease/heartbeat or dependency scheduler is claimed in this release.

## MCP runtime

Provider configuration is stored independently from product policy.

```text
provider record
  enabled
  transport
  accepted tool catalog
  credential refs
```

Credentials live in a separate secret store. Add/update/remove/enable/disable/sync operations atomically refresh the active runtime. Enabled providers expose all accepted tools; there is no workspace/profile/tool-subset grant layer in the simple product.

Runtime internals may retain supervisor state, health, generations and tool-drift information, but those are implementation details rather than user authorization concepts.

## Owner Console

Normal Owner Console surface:

```text
Overview / Recovery
Autonomy
Paths
Commands
MCP Servers
```

Routes are typed intents such as Add/Remove Path, replace Commands, Add/Enable/Disable/Test/Sync/Remove MCP. The browser does not construct generic owner command strings.

The autonomy control should clearly explain the difference between restricted policy boundaries and autonomous user-authority operation. A small Advanced area may expose status, audit or lifecycle diagnostics without introducing a second policy model.

## Control plane

The loopback control plane remains for bounded local diagnostics and revocation:

- status/policy projection;
- audit/metrics;
- OAuth client/token revocation;
- explicit local reload diagnostics where required.

It is not part of the AI model-facing MCP tool surface.

## Product management and standalone packaging

The end-user standalone product uses one immutable release identity:

```text
installRoot/
  current.json
  installation-marker.json
  versions/<version>/
    slnctrz-mcp
    release.json
```

Persistent customer state and runtime config live outside version directories. `installation.json` under state carries the matching installation ID; destructive uninstall requires install-root/state identity agreement before deleting managed roots.

Normal owner lifecycle commands are:

```text
status
doctor
config
update
rollback
repair
owner rotate-passphrase
uninstall
```

`doctor` is read-only. `repair` is intentionally bounded to safe non-secret generated state. Update/rollback use verified immutable release metadata; System Install restarts and health-checks the service.

The Linux System Install service resolves the active standalone SEA through the generated launcher. It does not depend on a repository `dist/` tree or system Node.js. Source/developer execution remains a separate Node `>=22.13.0 <25` model.

Standalone builds embed runtime resources that cannot depend on repository-local paths, including the model guide surfaced through `core.ping`.

## Audit persistence

Audit uses one privacy-reviewed metadata projection. Events are retained in a bounded in-memory journal for control-plane export and are also persisted to `<stateRoot>/audit.sqlite3` for restart-safe history. Core read/search/write/edit/exec, task operations, extension dispatch, auth/policy events and control-plane actions flow through this projection. Raw prompts, task instructions/results, file contents, provider payloads, command stdout/stderr and credentials are excluded by schema.

The SQLite record also carries semantic build version and injected build commit provenance. Durable retention is bounded to the newest 250,000 events by default. Persistence failure is surfaced as an operational error but does not replay or broaden a completed capability action.

## Snapshot activation

Policy and provider changes follow:

```text
validate
→ build candidate generation completely
→ atomically swap active generation
→ retire prior generation safely
```

A failed candidate never partially mutates the active generation.

## Security invariants

1. Public requests require valid OAuth authorization.
2. Restricted filesystem operations are contained under configured Paths and secret-path rules; autonomous filesystem operations follow gateway OS-user authority.
3. Restricted execution requires Paths cwd + `command.json`; autonomous execution follows gateway OS-user authority.
4. MCP credentials are not embedded in policy, logs, audit payloads, or model-visible tool metadata.
5. Enabled provider tools are exposed only through a ready runtime generation.
6. Normal product mutations do not require proposal/binding/profile ceremony.
7. Owner administration is not exposed through `owner.*` MCP tools.
8. The canonical Product Agent Harness is product working guidance, not authority; project instruction files remain separate contextual data and cannot override Kernel/Auth/Policy.
9. `task.start` reuses `core.exec` authority, while coordination tasks never grant execution/filesystem/network capability.
