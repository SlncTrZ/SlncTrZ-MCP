# SlncTrZ-MCP Architecture

## North star

**Owner-controlled access from Web AI to your Linux or Windows machine — files, commands, Agent Skills, tasks, and MCP servers through one gateway.**

Architecturally, SlncTrZ-MCP is the owner-controlled control, execution, and context layer between Web AI and the machine where the user’s work lives. The runtime is built around one product flow:

```text
Authenticated client
→ active policy snapshot
→ context.bootstrap for global + optional project guidance
→ current context receipt for ordinary work
→ policy-authorized core/task/media/provider tools
```

The owner manages a deliberately small **authority surface**:

```text
Autonomy
Paths
Commands
MCP Servers
```

Global/project instructions and Agent Skills are separately editable coding context. They influence
model behavior but are never an authority surface. Everything else is an internal safety/runtime
mechanism.

## Public gateway

The public MCP gateway owns:

- OAuth authentication and dynamic client registration where required.
- request limits, host/origin validation and MCP protocol dispatch.
- `core.ping`, `core.read`, `core.search`, `core.write`, `core.edit`.
- `core.exec` on Windows and POSIX. Restricted mode uses `command.json`; autonomous mode uses the gateway process user authority.
- coding-context tools `context.bootstrap`, `context.close`, `skills.list`, and `skills.read`.
- `media.read_image` when read authority is available.
- the in-process managed Task Runtime (`task.*`) when enabled.
- enabled MCP provider tools.

A principal is used for authentication and audit attribution only. It does not select workspace, profile, binding, or grant state.

OAuth durability is split deliberately: dynamic client registrations and acknowledged grant/token-family state are durable; access/refresh credentials are represented by cryptographic hashes/metadata rather than plaintext secrets. Pending authorization transactions and authorization codes remain bounded in-memory state and are lost on restart. Owner-secret abuse budgets charge failed authentication, not successful Owner logins/approvals.

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

Coordinator tasks are logical work records, not executable authority. They are visible within the resolved workspace, use deterministic single-winner claim semantics, allow only the current claimant to release/complete/fail, and allow the creator to cancel. Coordination instructions/results remain data and cannot override Kernel/Auth/Policy. When the bounded Coordinator store needs room, it evicts only the oldest terminal records using a stable terminal/update-time ordering; `available` and `claimed` work is never evicted.

Task IDs/state survive later MCP requests only while the same gateway process remains alive. Graceful application shutdown stops new work, cancels active Runner process trees, retires provider generations and closes listeners/audit resources before exit. Gateway restart clears Task Runtime state; no durable recovery, lease/heartbeat or dependency scheduler is claimed in this release. Forced termination that prevents the shutdown handler from running is outside that graceful-cleanup guarantee.

## MCP runtime

Provider configuration is stored independently from product policy.

```text
provider record
  enabled
  transport
  accepted tool catalog
  credential refs
```

Credentials live in a separate secret store. Credential rotation stages a new opaque ref, probes and activates a generation that uses it, then removes an old ref only after it is no longer referenced; a failed candidate keeps the prior usable credential/runtime state or reports recovery failure explicitly. Add/update/remove/enable/disable/sync operations atomically refresh the active runtime. Enabled providers expose all accepted tools; there is no workspace/profile/tool-subset grant layer in the simple product. Provider fault recovery never silently replays the tool call that observed the failure; recurrent `session_invalid` incidents are additionally bounded by a rolling incident budget that can quarantine a flapping provider.

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

The autonomy control should clearly explain the difference between restricted policy boundaries and autonomous user-authority operation. A small Advanced area may expose status, audit or lifecycle diagnostics without introducing a second policy model. Owner Console passphrase abuse control is failure-counted: successful logins do not consume the brute-force failure budget, while an exhausted failure window blocks subsequent attempts until reset.

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

`doctor` is read-only. `repair` is intentionally bounded to safe non-secret generated state. After the signing-enabled trust bootstrap, update/setup verifies the Ed25519 signature over exact canonical manifest bytes before parsing, then checks artifact size/SHA-256 and immutable release metadata before activation. System Install restarts and health-checks the service.

The Linux System Install service resolves the active standalone SEA through the generated launcher. It does not depend on a repository `dist/` tree or system Node.js. Source/developer execution remains a separate Node `>=22.13.0 <25` model.

Standalone builds embed runtime resources that cannot depend on repository-local paths, including the model guide surfaced through `core.ping`.

## Audit persistence

Audit uses one privacy-reviewed metadata projection. Events are retained in a bounded in-memory journal for control-plane export and are also persisted to `<stateRoot>/audit.sqlite3` for restart-safe history. Core read/search/write/edit/exec, task operations, extension dispatch, auth/policy events and control-plane actions flow through this projection. Raw prompts, task instructions/results, file contents, provider payloads, command stdout/stderr and credentials are excluded by schema.

The SQLite record also carries semantic build version and injected build commit provenance. Durable retention is bounded to the newest 250,000 events by default. Persistence failure is surfaced as an operational error but does not replay or broaden a completed capability action.

## Usage telemetry

Usage telemetry is deliberately separate from security audit. The public `/mcp` boundary observes exact request/response body byte counts after authentication and classifies only the MCP method/tool. A versioned model-neutral estimator (`utf8-bytes-v1`) derives approximate token counts from those bytes.

The usage path is passive:

```text
authenticated MCP exchange
        │
        ├── normal gateway execution ──► response
        │
        └── bounded UsageObserver ──► usage.sqlite3
```

`<stateRoot>/usage.sqlite3` stores numeric/classification metadata only. It does not persist request bodies, tool arguments, model prompts, file contents, command output, provider payloads, credentials, bearer tokens, or context receipts. A bounded in-memory queue decouples persistence from the response path; observer/store failure is logged and dropped rather than changing the MCP result. The Owner API exposes bounded health (`degraded`, dropped/pending counts and safe failure class) so telemetry loss is observable without becoming authority.

`HarnessRuntime` also emits a privacy-minimal progressive-disclosure measurement. For each bootstrap it records the compact bootstrap context plus all active `SKILL.md` bodies as the hypothetical eager-load baseline. First activation of a skill adds that skill body to the disclosed amount. Referenced resources remain ordinary measured gateway traffic and are not assumed to be part of the eager baseline.

Owner-visible aggregates are exposed only through authenticated `/owner/api/usage/*` routes. `/usage` is a read-only page shell that fetches those APIs; the existing Owner cookie remains scoped to `/owner`. Cost calculation is client-side from an owner-entered input-token price.

See [ADR-028](docs/adr/adr-028-passive-usage-telemetry.md).

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
10. When the coding harness is enabled, ordinary core/image/task/provider dispatch requires a current client/workspace/policy/revision-bound context receipt before effects; that receipt is not authorization.
11. Signing-enabled update/setup authenticates the canonical release manifest before parsing and still requires artifact size/SHA-256 verification before activation.
12. Successful Owner authentication does not consume failed-auth abuse budgets; exhausted failure budgets fail closed for their bounded window.

## Coding context, Agent Skills, and usage telemetry (v0.3.1)

`src/context` owns bounded global/project discovery, one-time provisioning and context receipts.
The product bootstrap creates one HarnessRuntime shared by isolated MCP exchanges. No transport
session or OAuth-client-wide "already read" flag is used. `context.bootstrap` returns instructions,
catalog metadata and a client/workspace/policy/revision-bound receipt. Ordinary core, image, task
and provider dispatch validates it before effects. Ping, bootstrap, context close and owned task
cancellation remain available for recovery.

`skills.read` activates SKILL.md or reads one referenced text resource. Global-only operation is
complete; explicit authorized project roots add optional instructions and skill overrides. The
server recomputes bounded content revisions without injecting skill bodies into each reply.
General filesystem and command authority remain unchanged. Provider calls strip the reserved
`slnctrzContext` argument. Host integrations may use `org.slnctrz/contextToken` request metadata.

See [ADR-027](docs/adr/adr-027-global-context-and-agent-skills.md),
[HARNESS.md](docs/HARNESS.md) and [CODING_AGENTS.md](docs/CODING_AGENTS.md).
