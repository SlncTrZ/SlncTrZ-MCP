# SlncTrZ-MCP Threat Model

> Scope: current schema-v2 gateway architecture. Historical workspace/profile/binding/proposal models belong in ADR history, not in the active security contract.
> Status: active implementation gate
> Updated: 2026-09-05

## 1. Security objective

SlncTrZ-MCP exposes local capabilities to authenticated AI clients without pretending that every operating mode has the same containment boundary.

The current product has four owner-facing concepts:

```text
Autonomy
Paths
Commands
MCP Servers
```

Security mechanisms behind those concepts include OAuth, canonical path handling, secret-path protection in restricted mode, bounded I/O, command-catalog execution, provider isolation, credential separation, atomic generation activation, owner authentication, bounded audit/metrics and verified standalone releases.

Authentication identifies and authenticates a client. Authorization comes from the active policy snapshot and selected authority mode.

## 2. Authority modes

### 2.1 Restricted

Restricted mode is the capability-controlled mode.

- Core filesystem tools operate under configured `Paths`.
- Protected-secret path rules apply to core filesystem operations.
- `core.exec` requires an authorized working Path plus a matching owner-managed command rule.
- Enabled MCP providers expose their accepted tools through the active provider generation.
- General-purpose shells/interpreters remain powerful: once authorized, the child process can use the OS permissions of the gateway service account. Restricted mode is therefore not an OS sandbox.

### 2.2 Autonomous

Autonomous mode deliberately follows the gateway process user's OS authority:

```text
model authority ≈ gateway process authority ≈ OS-user authority
```

The restricted Path boundary and protected-secret deny are not containment guarantees in this mode. OS account permissions, ACLs, service hardening, containers/VMs and external network controls become the authoritative boundaries.

The gateway never silently elevates privileges.

## 3. Protected assets

- Credentials, tokens, passphrases, private keys and provider secrets.
- Files that are outside restricted-mode configured Paths.
- Integrity of files modified through core write/edit operations.
- Trusted executable identity and command-catalog integrity.
- OAuth authorization state, dynamic-client state and token families.
- Owner-managed policy, command and provider state.
- Provider credentials and accepted tool catalogs.
- Availability of the gateway process, child-process capacity, Task Runtime capacity and provider supervisors.
- Audit attribution and release/build provenance.
- Integrity of the active runtime generation.

## 4. Trust boundaries

1. **Public ingress** accepts network traffic but grants no authority by itself.
2. **OAuth** establishes authenticated client identity and valid scope.
3. **Active policy snapshot** selects restricted/autonomous authority and core capabilities.
4. **Filesystem kernel** performs canonical path resolution, bounded UTF-8 I/O, symlink/race checks and restricted-mode secret protection.
5. **Exec kernel** resolves and revalidates executable identity, bounds argv/output/time and terminates process trees.
6. **Task Runtime** keeps bounded in-process Runner/Coordinator state; Runner launch reuses Exec authority while coordination state carries no capability authority.
7. **Extension registry/runtime** binds namespaced provider tools to fixed transports and accepted catalogs.
8. **Credential store** resolves provider secrets without exposing them through normal model-facing metadata.
9. **Owner control plane / Owner Console** is separately authenticated and is not a model-facing admin tool surface.
10. **Audit/metrics** accept only bounded privacy-reviewed projections.
11. **Standalone release path** verifies release metadata and artifact bytes before activation.

Product/project instructions, coordination-task instructions/results, prompts, provider descriptions and MCP tool output are data, not capability grants.

## 5. Threats and controls

| Threat                           | Example                                                             | Required control                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Lexical traversal                | `../../secret`                                                      | Normalize and reject path escape before I/O.                                                                                                |
| Symlink escape                   | Path resolves outside a restricted root                             | Canonical `realpath` containment; deny unsafe final write symlinks.                                                                         |
| TOCTOU write race                | File replaced between validation and overwrite                      | Optimistic SHA-256 check, re-read before replacement, atomic same-directory write.                                                          |
| Restricted secret disclosure     | `.env`, `.ssh`, credential files                                    | Protected-secret deny in restricted mode.                                                                                                   |
| Autonomous-mode ambiguity        | Docs claim secret/path containment while code follows OS user       | Explicit mode contract in README/ARCHITECTURE/SECURITY and tool descriptions.                                                               |
| Invalid encoding                 | Malformed UTF-8                                                     | Fatal UTF-8 decode and stable error.                                                                                                        |
| Resource exhaustion              | Huge tree/file/output                                               | Hard bytes/results/entries/argv/output/time limits.                                                                                         |
| Write corruption                 | Crash during overwrite                                              | Temporary file, fsync, atomic replacement/link, cleanup.                                                                                    |
| Shell injection                  | Caller-controlled shell string                                      | Direct spawn; fixed executable; no generic shell interpolation in core exec.                                                                |
| Executable substitution          | Catalog binary changes after authorization                          | Canonical executable identity stored/revalidated immediately before spawn.                                                                  |
| Environment leakage              | Child inherits secrets                                              | Minimal explicit environment rather than wholesale inheritance.                                                                             |
| Process leak                     | Timeout/disconnect leaves descendants                               | Cancellation propagation and process-tree termination with grace period.                                                                    |
| Task privilege confusion         | Caller treats `task.start` as authority beyond `core.exec`          | Runner launch reuses the same policy/Exec authorization path.                                                                               |
| Coordination confused deputy     | Task text asks claimant to exceed current authority                 | Coordination text is context only; Kernel/Auth/Policy remains authoritative.                                                                |
| Coordination claim race          | Two clients believe they own the same logical task                  | Deterministic atomic single-winner claim in one gateway process.                                                                            |
| Task-state exhaustion            | Client fills in-memory Runner/Coordinator capacity                  | Fixed bounds; Coordinator evicts only oldest terminal history, while active work remains non-evictable and full-active capacity fails loud. |
| Windows command-script injection | `.cmd/.bat` metacharacters                                          | Reject unsafe command-script metacharacters and use controlled Windows invocation.                                                          |
| Namespace collision              | Provider shadows core/another provider                              | Candidate generation fails closed; previous generation remains active.                                                                      |
| Provider discovery drift         | Runtime tools differ from accepted catalog                          | Readiness attestation and fail-closed provider availability.                                                                                |
| Provider credential leak         | Secret appears in tool metadata/log/audit                           | Separate credential store and schemas that cannot carry secret values.                                                                      |
| Credential rotation rollback     | New secret overwrites/deletes active prior secret before activation | Stage opaque new ref, probe/activate new generation, then cleanup only unreferenced old refs.                                               |
| Provider exhaustion              | Hung/crashing provider                                              | Bounded timeout/message/output/restart and supervisor state.                                                                                |
| Hybrid generation                | New policy uses old/partial provider state                          | Build complete candidate then atomically swap active generation.                                                                            |
| Owner impersonation              | Local process calls control API                                     | Owner verifier on every route plus failed-auth rate limiting.                                                                               |
| Public admin exposure            | `/owner`/control action accidentally becomes MCP tool               | No model-facing `owner.*`; control routes are separately handled/authenticated.                                                             |
| Host/origin abuse                | Hostile Host/Origin headers                                         | Explicit hostname/origin validation before dispatch.                                                                                        |
| JSON-RPC/body abuse              | Bad envelope, oversized body, invalid UTF-8                         | Strict bounded HTTP parsing and protocol validation.                                                                                        |
| Audit disclosure                 | Args/content/credentials persisted                                  | Fixed metadata-only schemas; no raw payloads by default.                                                                                    |
| Audit exhaustion                 | Unbounded journal                                                   | Fixed-capacity in-memory journal and bounded persistent sink if enabled.                                                                    |
| Release substitution             | Modified binary under valid version label                           | Manifest size + SHA-256 verification before activation.                                                                                     |
| Redirect downgrade/substitution  | Release URL redirects to unsafe scheme/origin chain                 | HTTPS-only bounded redirects with explicit validation before accepting bytes.                                                               |
| Mixed deployment                 | Live directory contains files from multiple generations             | Immutable versioned release directories and atomic activation pointer.                                                                      |
| Destructive-root confusion       | Tampered state points uninstall at an unrelated directory           | Independent install-root + state installation IDs must match before deletion.                                                               |
| Version drift                    | `package.json` and runtime identities disagree                      | One canonical build-info source plus consistency/release gate tests.                                                                        |
| Provenance loss                  | Runtime cannot identify source commit                               | Inject exact build commit in CI/deployment; surface it in binary/runtime diagnostics.                                                       |

## 6. Filesystem requirements

### Restricted mode

- Every core read/search/write/edit target must resolve under one configured Path.
- Canonical containment must be checked after resolving symlinks.
- Protected secret names such as `.env`, `.ssh`, `.aws`, `.gnupg`, private-key filenames and equivalent configured classes remain denied.
- Reads are bounded and strict UTF-8.
- Searches are bounded by entries/results/time and deterministic where possible.
- Existing-file overwrite requires `expectedSha256`.
- Writes use same-directory temporary files and atomic replacement/creation.
- Exact edit rejects missing, ambiguous or overlapping matches.

### Autonomous mode

Filesystem operations may use any path accessible to the gateway OS user. The same deterministic I/O guards, write atomicity, limits and error handling should remain active, but restricted root/secret containment is intentionally disabled.

This distinction must be visible in user/model documentation and must not be obscured by generic claims such as “secret deny always overrides allow.”

## 7. Execution requirements

### Restricted execution

`core.exec` requires:

```text
core.exec capability
+ authorized working Path
+ owner-managed command rule
+ canonical executable revalidation
```

Additional controls:

- up to 4,096 argv entries, with a 128 KiB-minus-NUL per-argument ceiling;
- aggregate argv remains platform-bounded: 1 MiB on Linux/POSIX, 30,000 UTF-16 code units for native Windows commands, and 7,500 characters for Windows command scripts;
- bounded stdout/stderr capture;
- hard timeout ceiling;
- cancellation support;
- reduced environment;
- process-tree termination;
- stable audit identity using approved command identity rather than raw command output.

Authorizing a shell/interpreter is an explicit owner decision and can effectively expose the service account's broader OS powers from inside that child process.

### Autonomous execution

Autonomous execution follows the gateway OS-user token. The runtime must still keep output/time/process-cleanup guards and must not claim privilege elevation.

### Managed task requirements

- `task.start` must use the same Restricted/Autonomous execution authorization as `core.exec`.
- Runner tasks are creator-private and workspace-bound.
- Aborting `task.wait` must not cancel the underlying process; explicit `task.cancel` owns cancellation.
- Coordination tasks are workspace-visible logical state with exactly one claimant at a time.
- Only the current claimant may release/complete/fail; creator cancellation remains explicit.
- Task instructions/results must not be stored in metadata-only audit records.
- Task Runtime state is intentionally in-memory in the current product and is cleared on gateway restart.
- Graceful SIGTERM/SIGINT shutdown stops new work, cancels active Runner process trees, retires provider generations and closes listeners/audit resources before exit; forced termination that prevents handlers from running is outside this guarantee.
- Coordinator retention may prune only terminal history; `available` and `claimed` work is never evicted to make room.
- No durable recovery, lease/heartbeat, dependency DAG or resource-lock claim is made unless separately implemented and tested.

## 8. Extension provider requirements

- Provider transport is owner-declared and fixed by manifest/state, not selected per tool call.
- Provider credentials are resolved from opaque refs and never returned to the model.
- Stdio providers run out of the gateway core process with `shell:false` where applicable.
- HTTP providers use validated HTTPS endpoints, with the documented loopback HTTP exception only where explicitly allowed.
- Redirects must not cross the fixed origin.
- Tool catalogs are namespaced and collision checked.
- Runtime discovery/tool drift must fail closed.
- Message, output, timeout and restart behavior are bounded.
- Provider failures must not terminate the core gateway.
- Enable/disable/sync mutations build and activate a complete valid generation or leave the previous generation untouched.

Provider isolation is process/protocol isolation, not an OS sandbox. An untrusted local provider still has the OS authority of its process identity unless external containment is used.

## 9. OAuth and public protocol requirements

- MCP tool dispatch requires valid bearer authorization.
- PKCE, audience, expiry and scope checks remain enforced where applicable.
- Refresh rotation and family revocation must invalidate the correct token lineage.
- Dynamic-client registration and repeated owner-auth attempts are rate limited.
- Unsupported MCP protocol versions fail before normal tool use.
- Malformed JSON, JSON-RPC batches/envelopes, invalid UTF-8 and unsupported media types fail with stable non-secret errors.
- Public MCP request bodies are bounded at 16 MiB; core UTF-8 read/write/edit payloads are bounded at 8 MiB.
- Provider request/response messages default to 8 MiB and remain hard-bounded at 16 MiB.
- Host/origin validation occurs before public dispatch.
- Credentials must never be reflected in OAuth/owner failure responses.

## 10. Owner/control-plane requirements

The owner surface manages only the current product concepts:

```text
Autonomy
Paths
Commands
MCP Servers
```

There is no active workspace/profile/binding/proposal authorization ceremony.

Requirements:

- every owner action requires owner authentication;
- request bodies are bounded;
- responses are non-cacheable where sensitive;
- malformed intents fail closed;
- mutations are typed and validated;
- owner admin is not exposed as model-facing MCP tools;
- policy/provider mutation activates atomically;
- local diagnostics may expose safe status/audit projections but not credentials or raw secret-bearing config.

## 11. Audit and observability requirements

The default audit design is privacy-first metadata.

Allowed categories include auth, policy, tool and control events. Typical safe fields:

```text
timestamp
request/client id
capability/tool id
policy version
result/decision
duration
approved command/provider identity when safe
build version/build commit
```

Raw file contents, model prompts, task instructions/results, provider payloads, credentials and command stdout/stderr must not be stored by default.

The in-memory journal remains bounded for fast control-plane export, and the same privacy-reviewed projection is persisted by default to `<stateRoot>/audit.sqlite3`. Durable retention defaults to the newest 250,000 events and is pruned transactionally by the sink. SQLite persistence failure is surfaced through diagnostics but must not broaden authority or cause a completed tool action to be replayed.

Successful and failed core read/search/write/edit/exec and task operations are included in the tool audit projection; provider dispatch and control-plane actions are also journaled without raw payloads.

## 12. Release and deployment requirements

A production instance should be traceable to one immutable artifact.

Preferred flow:

```text
canonical main commit/tag
→ CI quality + docs/provenance gate
→ build artifact with embedded {version, buildCommit}
→ manifest {version, target, URL, size, sha256}
→ SHA256SUMS + release identity gate
→ prerelease candidate
→ real public redirect + clean install acceptance
→ verified version directory
→ atomic activation
→ restart where applicable
→ health/status/core.ping confirms running version + buildCommit
→ promote public release
```

Requirements:

- same-version different bytes fail closed;
- interrupted download/install does not replace current activation;
- rollback targets must already exist and verify;
- active deployment directory must not be mutated by copying selected compiled files into it;
- semantic version comes from one canonical package/build source;
- build commit is explicit and must not be fabricated when unavailable.

## 13. Cross-platform requirements

A platform is supported only when its security-sensitive behavior is continuously tested on that platform.

Linux CI must cover Node 22 and 24. Windows claims require a Windows runner covering at minimum:

- filesystem boundary behavior;
- private ACL handling;
- native executable resolution;
- `.cmd/.bat` safety behavior;
- timeout/cancellation/process-tree termination;
- restricted and autonomous execution semantics.

Linux-only skipped Windows tests are not evidence of Windows correctness.

## 14. Current evidence map

Key test families:

- `tests/conformance/mcp-initialize.test.ts` — protocol negotiation and malformed ingress.
- `tests/conformance/default-workspace-e2e.test.ts` — schema-v2 Paths and restricted/autonomous behavior.
- `tests/conformance/exec-command-catalog-e2e.test.ts` — restricted command-catalog execution.
- `tests/conformance/extension-gateway-e2e.test.ts` — provider transport/credential/tool exposure.
- `tests/conformance/task-runner-e2e.test.ts` — request-independent Runner launch/wait/cancel and policy reuse.
- `tests/conformance/task-coordinator-e2e.test.ts` — independent authenticated clients and single-winner coordination claim.
- `tests/unit/task-runtime.test.ts`, `task-coordinator.test.ts` — bounded task state/ownership transitions.
- `tests/unit/fs-boundary.test.ts`, `fs-read`, `fs-search`, `fs-write`, `fs-edit` — filesystem kernel.
- `tests/unit/exec-run.test.ts` — execution bounds and process behavior.
- `tests/unit/oauth-*` — authorization, PKCE, token families and HTTP flow.
- `tests/unit/extension-*` — manifest, runtime, adapters, supervisor and drift behavior.
- `tests/unit/owner-*` — owner state and provider lifecycle.
- `tests/unit/audit-*`, `metrics.test.ts` — privacy projection and bounded observability.
- `tests/unit/standalone-*`, `release-manifest.test.ts`, `manifest-fetch.test.ts`, `product-management.test.ts` — release verification, setup, lifecycle, diagnostics and activation.
- `scripts/clean-release-user-e2e.sh` — exact public release redirect/bootstrap/User Install acceptance after candidate publication.
- `scripts/clean-release-system-e2e.sh` — guarded destructive System Install acceptance for disposable systemd hosts only.
- `tests/unit/windows-private-acl.test.ts` — Windows-specific secret/state ACL behavior; must run on Windows CI.

## 15. Residual risks

1. Node.js cannot provide identical race-free filesystem primitives on every OS; platform-specific testing remains required.
2. A permitted shell/interpreter can escape the practical intent of a restricted command list because the child process has the gateway OS account's authority.
3. Autonomous mode intentionally has broad local authority and should be reserved for trusted personal/automation hosts.
4. Local stdio MCP providers are not OS-sandboxed by the gateway.
5. Metadata-only auditing favors privacy over complete forensic reconstruction even though restart-safe SQLite history is enabled by default.
6. External OS/network/container policy remains necessary for untrusted multi-tenant workloads.
7. Build provenance is only as strong as the release/deployment process that injects and verifies it.
