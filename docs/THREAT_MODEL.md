# Minimal Tool Kernel Threat Model

> Scope: Phase 3 filesystem and command primitives
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
5. The kernel performs bounded I/O or process execution.
6. Output is truncated/redacted before it becomes model-visible.

Workspace instructions, tool descriptions, prompts, and client annotations cannot grant
capabilities.

## 4. Threats and required controls

| Threat                   | Example                                | Required control                                                                          |
| ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Lexical traversal        | `../../secret`                         | Reject absolute paths, NUL bytes, and lexical escape before I/O                           |
| Symlink escape           | Workspace link points outside          | Resolve real paths and verify canonical containment                                       |
| TOCTOU replacement       | File changes after validation          | Open with no-follow where supported, validate the opened handle, bound reads, fail closed |
| Secret disclosure        | `.env`, `.ssh`, repository internals   | Non-overridable secret path deny rules                                                    |
| Encoding ambiguity       | Invalid UTF-8 becomes replacement text | Fatal UTF-8 decoding; explicit encoding errors                                            |
| Resource exhaustion      | Huge file/tree/output                  | Byte, entry, depth, result, time, and output limits                                       |
| Nondeterminism           | Filesystem enumeration order changes   | Stable binary ordering and explicit truncation metadata                                   |
| Write corruption         | Crash during overwrite                 | Same-directory temporary file, flush, atomic replacement, cleanup                         |
| Write/execute escalation | Write script then execute it           | Writable roots cannot overlap trusted executable roots                                    |
| Shell injection          | Arguments interpreted by a shell       | Direct spawn by default; shell is a separate denied capability                            |
| Environment leakage      | Child inherits host secrets            | Explicit environment allowlist and empty/minimal inherited environment                    |
| Network escape           | Command opens remote connection        | Network is an independent capability and default-deny                                     |
| Cancellation failure     | Client disconnect leaves work running  | Request deadline and cancellation propagated to kernel operations                         |
| Error disclosure         | Absolute path or secret in error       | Stable error codes and non-sensitive messages                                             |
| Race and platform drift  | Security behavior differs by OS        | Platform-specific tests; unsupported guarantees fail closed                               |

## 5. Capability composition rules

- `core.read` and `core.search` require an explicit read root and hard secret-deny.
- `core.write` and `core.edit` require an explicit writable root and mutation policy.
- `core.exec` requires an executable trust root, binary/subcommand/argument policy,
  bounded environment, timeout, output limit, and cancellation.
- Writable roots must not overlap executable trust roots in either direction.
- Read permission does not imply write, execute, network, or secret access.
- A policy increase is rejected until explicitly approved and atomically activated.

## 6. Phase gates

### Read-only gate

- Canonical containment and secret-deny are shared mechanisms.
- Reads are handle-based, bounded, and strict UTF-8.
- Search bounds scanned entries, depth, results, duration, and output.
- Results are deterministic and report truncation.
- Authenticated MCP integration tests call both tools.

### Mutation gate

- Threat model reviewed.
- Atomic replacement and failure cleanup tests pass.
- Symlink/race tests cover existing and newly created targets.
- Dry-run and expected-content hash are implemented.
- Audit attribution includes client and policy snapshot.
- No writable/executable root overlap is possible.

### Execution gate

- Direct process spawn only.
- Binary, subcommand, arguments, cwd, environment, stdin, network, timeout, and output
  are independently authorized.
- Process-tree cancellation and output backpressure are tested.
- Inline evaluation and implicit shell execution remain denied unless separately approved.

## 7. Residual risks

Portable Node.js APIs cannot provide identical race-free path semantics on every target.
The implementation therefore combines lexical checks, canonical containment, no-follow
opening where supported, opened-handle validation, and platform-specific tests. A target
that cannot meet the documented guarantee must fail closed or be excluded from the
supported matrix.
