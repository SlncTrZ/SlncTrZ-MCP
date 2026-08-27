# Gateway Threat Model

> Scope: Phase 3 kernel, Phase 4 policy snapshots, and Phase 5 extension gateway
> Status: active implementation gate
> Updated: 2026-08-27

## 1. Security objective

The minimal kernel exposes a small set of composable tools without turning an
authenticated MCP connection into unrestricted host access. Authentication identifies
the caller; it does not authorize paths, commands, environment variables, secrets, or
network access.

The kernel remains default-deny. A missing workspace policy exposes no filesystem tool
data and permits no mutation or command execution.

## 2. Protected assets

- Files outside configured workspace roots.
- Credentials, tokens, private keys, environment files, and repository internals.
- Host executables and trusted executable directories.
- Gateway runtime secrets and OAuth state.
- Integrity of existing files, permissions, ownership, and line endings.
- Availability of the gateway process, filesystem, and child-process capacity.
- Audit attribution and deterministic tool results.

## 3. Trust boundaries

1. Public ingress terminates transport but is not an authorization boundary.
2. OAuth establishes client identity and scope.
3. The policy snapshot authorizes a capability for one workspace and request.
4. The filesystem boundary canonicalizes paths and applies hard secret-deny rules.
5. The kernel performs bounded I/O or fixed-command process execution.
6. The extension registry binds canonical names to operator-declared providers; workspace
   and profile grants remain exclusively in the policy snapshot.
7. An extension runtime executes out-of-process through a fixed stdio or HTTPS transport.
8. Output is truncated/redacted before it becomes model-visible.

Workspace instructions, tool descriptions, prompts, and client annotations cannot grant
capabilities.

## 4. Threats and required controls

| Threat                   | Example                                   | Required control                                                                            |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Lexical traversal        | `../../secret`                            | Reject absolute paths, NUL bytes, and lexical escape before I/O                             |
| Symlink escape           | Workspace link points outside             | Resolve real paths and verify canonical containment                                         |
| TOCTOU replacement       | File changes after validation             | Open with no-follow where supported, validate the opened handle, bound reads, fail closed   |
| Secret disclosure        | `.env`, `.ssh`, repository internals      | Non-overridable secret path deny rules                                                      |
| Encoding ambiguity       | Invalid UTF-8 becomes replacement text    | Fatal UTF-8 decoding; explicit encoding errors                                              |
| Resource exhaustion      | Huge file/tree/output                     | Byte, entry, depth, result, time, and output limits                                         |
| Nondeterminism           | Filesystem enumeration order changes      | Stable binary ordering and explicit truncation metadata                                     |
| Write corruption         | Crash during overwrite                    | Same-directory temporary file, flush, atomic replacement, cleanup                           |
| Write/execute escalation | Write script then execute it              | Writable roots cannot overlap trusted executable roots                                      |
| Shell injection          | Arguments interpreted by a shell          | Direct spawn by default; shell is a separate denied capability                              |
| Environment leakage      | Child inherits host secrets               | Explicit environment allowlist and empty/minimal inherited environment                      |
| Network escape           | Command opens remote connection           | Network is an independent capability and default-deny                                       |
| Cancellation failure     | Client disconnect leaves work running     | Request deadline and cancellation propagated to kernel operations                           |
| Error disclosure         | Absolute path or secret in error          | Stable error codes and non-sensitive messages                                               |
| Race and platform drift  | Security behavior differs by OS           | Platform-specific tests; unsupported guarantees fail closed                                 |
| Namespace collision      | Provider shadows another tool             | Fatal candidate compile; retain the prior active registry/snapshot                          |
| Provider discovery drift | Runtime tool set differs from manifest    | Exact eager readiness attestation; malformed/drifted provider remains unavailable           |
| Provider exhaustion      | Crash loop, hung call, flood, full queue  | Bounded time/message/output/queue/restart; quarantine without terminating the gateway       |
| Hybrid reload            | New policy calls an old provider runtime  | Capture one immutable snapshot/runtime generation; lease old runtime through active calls   |
| Extension secret leak    | Args, output, endpoint, credential logged | Stable errors and fixed audit schema excluding provider-controlled or secret-bearing fields |

## 5. Capability composition rules

- `core.read` and `core.search` require an explicit read root and hard secret-deny.
- `core.write` and `core.edit` require an explicit writable root and mutation policy.
- `core.exec` requires an executable trust root, binary/subcommand/argument policy,
  bounded environment, timeout, output limit, and cancellation.
- Writable roots must not overlap executable trust roots in either direction.
- Read permission does not imply write, execute, network, or secret access.
- A policy increase is rejected until explicitly approved and atomically activated.

Phase 4 reload and approval boundary (2026-08-27):

- The active policy is one immutable, versioned snapshot; a reload either activates a whole
  validated candidate or changes nothing (no partial workspace merge, no in-place mutation).
- A missing policy file and an empty workspace list both compile to deny-all (yes-only).
- A reload is serialized; a concurrent call returns `reload_in_progress` without queuing.
- A risk-increasing change (adds a workspace/binding/profile/capability, broadens a root
  or child PATH/fixed environment, or removes a deny) is blocked until an approval hook
  says `approved`. The default hook is `unavailable`, so it returns `approval_required`.
- The decision audit carries versions, counts, a risk flag, and a result only; it never
  contains paths, config text, roots, argv, environment values, client binding ids, or
  credentials. A sink failure cannot undo an already-completed activation.

## 6. Phase gates

### Read-only gate

- Canonical containment and secret-deny are shared mechanisms.
- Reads are handle-based, bounded, and strict UTF-8.
- Search bounds scanned entries, depth, results, duration, and output.
- Results are deterministic and report truncation.
- Authenticated MCP integration tests call both tools.

### Mutation gate

> Status: passed for `core.write` and `core.edit` on 2026-08-27. Revalidate
> writable/executable root composition when `core.exec` is introduced.

- Threat model reviewed.
- Atomic replacement and failure cleanup tests pass.
- Symlink/race tests cover existing and newly created targets.
- Dry-run and expected-content hash are implemented.
- Exact-match edits resolve against one immutable base snapshot and reject missing,
  ambiguous, and overlapping matches without falling back to fuzzy behavior.
- Editing never creates a file and preserves untouched bytes, line endings, and UTF-8.
- Audit attribution includes client and policy snapshot.
- No writable/executable root overlap is possible.

### Execution gate

> Status: passed for POSIX Phase 3.1 `core.exec` on 2026-08-27 (ADR-017). Windows is
> explicitly deferred and not claimed covered; a later Windows slice requires a
> reviewed Job Object/native-helper ADR. Revalidate writable/executable root
> composition if a caller-controlled argument policy is ever added.

- Direct process spawn only; the caller selects a pre-authorized `commandId`, never a
  binary, shell string, or free-form argv.
- Fixed commands only: no caller args, cwd, or stdin in Phase 3.1.
- `execRoot` must not overlap `writeRoot` in either direction, failing closed at startup.
- Child environment is a fixed allowlist; loader/runtime-injection keys are denied and
  the gateway environment is never inherited.
- Timeout and cancellation kill the full process group (POSIX) with a bounded grace
  period; a non-zero exit code is a result, not an error.
- Output is bounded and deterministically truncated; audit carries no args, stdin,
  output, cwd, or environment values.

### Extension gateway gate

> Status: passed for Linux Node 22.23.2 and 24.19.0 on 2026-08-27 (ADR-020).
> Windows execution/isolation evidence is not claimed by this checkpoint.

- Manifests are strict operator-owned declarations with fixed executable/endpoint,
  canonical tools, risk ceilings, timeouts, queue/output/message caps, and restart budget.
- Stdio uses `shell: false`, fixed argv/cwd, and a minimal explicit environment; it never
  inherits the gateway environment wholesale.
- HTTPS endpoints reject credentials, query strings, fragments, non-HTTPS schemes, and
  cross-origin redirects.
- Policy grants are the only workspace/profile authorization source. Authenticated
  discovery exposes `authorized ∩ ready`, and dispatch rechecks the captured runtime.
- Malformed discovery, duplicate namespace, runtime tool drift, provider timeout/crash,
  output flood, queue overload, and restart exhaustion fail closed.
- Reload compiles the full candidate off-side, retains the old snapshot on failure,
  retires valid non-activated candidate runtimes, and drains old runtime leases after
  activation.
- Extension audit contains attribution, canonical identity, policy version, risk, result,
  and duration only; no args, provider output, endpoint, env, credential ref, manifest
  text, or raw provider error is recordable by the schema.

## 7. Residual risks

Portable Node.js APIs cannot provide identical race-free path semantics on every target.
The implementation therefore combines lexical checks, canonical containment, no-follow
opening where supported, opened-handle validation, and platform-specific tests. A target
that cannot meet the documented guarantee must fail closed or be excluded from the
supported matrix.

Phase 5 adds process and protocol isolation, not an OS sandbox. A stdio provider still
has the filesystem and network authority of the gateway service identity, while an HTTPS
provider reaches its fixed origin. Operators must use a restricted service identity and
external OS/container controls before accepting untrusted provider code, broad host
access, or multi-tenant workloads. Dynamic installation, remote credential retrieval,
and a public extension control plane remain out of scope.
