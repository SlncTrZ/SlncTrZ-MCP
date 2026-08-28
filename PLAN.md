# SlncTrZ-MCP Development Plan

> Status: proposed  
> License: Apache-2.0  
> Architecture style: minimal trusted kernel with isolated extensions  
> Distribution goal: developer workflow plus self-contained standalone releases

## 1. Purpose

SlncTrZ-MCP is a local-first MCP gateway that connects AI web clients to controlled local capabilities through one stable public endpoint.

The project is designed around four goals:

1. Keep the trusted tool kernel small, explicit, and composable.
2. Support external MCP servers without forcing every extension into the core process.
3. Enforce filesystem, execution, identity, and secret boundaries by mechanism.
4. Deliver a non-developer standalone experience without compromising the developer workflow.

## 2. Project principles

### 2.1 Clean-room implementation

SlncTrZ-MCP is an independent implementation.

- Architecture is derived from project requirements, public protocol specifications, measured behavior, and independently written tests.
- Do not copy source code, comments, documentation, UI text, naming conventions, or test fixtures from reference implementations.
- Every production module must have clear provenance: project requirement, protocol requirement, or an independently recorded design decision.
- Third-party dependencies must be tracked with their own license and notice obligations.
- Reference repositories and research notes must remain outside the tracked project source.

### 2.2 Pi-inspired simplicity

The kernel follows the simplicity of Pi Coding Agent:

- Prefer a few orthogonal primitives over a large catalog of overlapping tools.
- Let the model compose primitives instead of encoding workflows into dozens of specialized tools.
- Keep the default behavior useful without requiring an agent framework.
- Add capabilities through explicit profiles and extensions.
- Do not put plan mode, sub-agents, memory, or business-specific workflows into the kernel.

This principle applies to the trusted kernel. It does not mean the gateway is limited to four capabilities.

### 2.3 Security by mechanism

Prompt instructions are not a security boundary.

- Default deny.
- No implicit access to the user's home directory.
- Credential and session directories are denied independently of workspace configuration.
- Read, write, execute, network, and secret access are separate capabilities.
- Writable roots cannot also be trusted executable roots.
- Every mutation must be attributable to an authenticated client and policy snapshot.
- Dangerous capability changes require explicit approval.

### 2.4 Stable external contract

- Tool identities are public API.
- Internal refactoring must not silently rename tools.
- Every extension receives a canonical namespace.
- Protocol compatibility and deprecation rules are documented.
- The public endpoint is independent of the selected ingress provider.

### 2.5 Evidence before claims

- Static review does not close runtime work.
- Benchmark before optimizing.
- A packaged archive is not automatically a standalone executable.
- A successful build is not proof of cross-platform operation.
- Release documentation must describe the artifact that actually exists.

## 3. Product boundaries

### In scope

- MCP transport and compatibility layer.
- OAuth authorization and client identity.
- Minimal local tool kernel.
- Policy-controlled filesystem and command execution.
- Namespaced MCP extension gateway.
- Lifecycle supervision for external MCP servers.
- Project instruction discovery with explicit provenance.
- Local control plane.
- Audit events and operational telemetry.
- Developer and standalone distribution modes.

### Out of scope for the kernel

- General multi-agent orchestration.
- Built-in business workflows.
- Model routing as a mandatory dependency.
- Hidden system-prompt injection.
- Automatic access to credential stores.
- A fixed dependency on one tunnel or edge provider.
- Executing third-party extensions inside the trusted process by default.

## 4. Capability profiles

| Profile | Default tools | Intended use |
| --- | --- | --- |
| Read-only | `core.read`, `core.search` | Inspection and review |
| Minimal | `core.read`, `core.write`, `core.edit`, `core.exec` | Pi-style coding work |
| Filesystem extended | Adds `core.mkdir`, `core.move`, `core.stat` | Explicit file operations where shell is restricted |
| Gateway | Namespaced extension tools | Database, Git, container, API, and business capabilities |
| Custom | Administrator-selected capabilities | Project-specific operation |

Profiles select capabilities; they do not bypass policy.

## 5. Architecture decisions

| ID | Decision | Status |
| --- | --- | --- |
| ADR-001 | TypeScript and Node.js for the gateway core | Accepted |
| ADR-002 | Apache-2.0 project license | Accepted |
| ADR-003 | Trusted kernel runs in-process | Accepted |
| ADR-004 | Third-party MCP servers run in isolated child processes by default | Accepted |
| ADR-005 | Policy Engine is the single source of authorization truth | Accepted |
| ADR-006 | Isolated modern MCP with stateless legacy compatibility | Accepted |
| ADR-007 | Tool registry uses canonical names independent of runtime topology | Accepted |
| ADR-008 | Standalone packaging is separated from runtime architecture | Accepted |
| ADR-009 | Project instructions are explicit context, not a security mechanism | Accepted |
| ADR-010 | No home-directory access by default | Accepted |
| ADR-011 | Embedded owner-only OAuth for Phase 1 dogfood | Accepted |
| ADR-012 | Grant-family token revocation and redacted authentication audit | Accepted |
| ADR-013 | Bound ephemeral OAuth allocations | Accepted |
| ADR-014 | Non-overridable secret-path denial in the kernel | Accepted |
| ADR-015 | Policy-bound atomic filesystem writes | Accepted |
| ADR-016 | Deterministic exact-match filesystem edits | Accepted |
| ADR-017 | Policy-bound direct process execution | Accepted |
| ADR-018 | Versioned immutable policy snapshots and atomic activation | Accepted |
| ADR-019 | Scoped developer access and sandbox escalation | Accepted |
| ADR-020 | Bounded isolated MCP extension transports | Accepted |

## 6. Delivery roadmap

### Phase 0 — Repository and governance foundation

Deliverables:

- Initialize the independent repository.
- Add Apache-2.0 license after confirming the copyright holder string.
- Add contribution, security, provenance, and release policies.
- Establish formatting, linting, type checking, unit testing, and CI.
- Define supported Node.js and operating-system versions.
- Keep research material outside tracked source.

Acceptance criteria:

- Repository contains no copied reference material.
- CI runs on a clean checkout.
- Dependency licenses are inventoried.
- All architecture decisions have owners and status.

### Phase 1 — Protocol and ingress core

> Implementation status: complete (2026-08-28) — HTTP server, MCP Streamable HTTP endpoint,
> transport adapter boundary, per-request modern context with stateless legacy session,
> protocol/capability validation, secret-free client error model, and health/readiness
> endpoints are implemented and covered through HTTP dispatch plus the dedicated MCP
> conformance suite. Phase 9 closed the remaining acceptance gaps by adding protocol
> negotiation/rejection coverage in `tests/conformance` and explicit rejection of
> unsupported MCP protocol versions without opening a session.

Deliverables:

- HTTP server and MCP endpoint.
- Transport adapter boundary.
- Modern request-context implementation.
- Legacy initialization/session adapter.
- Protocol and capability validation.
- Client-facing error model.
- Health and readiness endpoints.

Acceptance criteria:

- Conformance tests cover supported MCP revisions.
- Modern requests do not depend on global negotiated state.
- Legacy sessions are isolated by client and security context.
- Unsupported protocol versions fail explicitly.
- Ingress can run locally without a tunnel.

### Phase 2 — Identity and authorization

> Implementation status: complete (2026-08-26) — embedded owner OAuth, PKCE,
> bounded DCR, token rotation, grant-family revocation, rate limiting, and redacted
> auth audit are implemented. The deployed gateway completed real-client OAuth-to-MCP
> runtime verification with an authenticated `core.ping` response.

Deliverables:

- OAuth metadata endpoints.
- PKCE support.
- Dynamic client registration policy.
- Client registration, token, refresh, and revocation lifecycle.
- Redirect URI policy.
- Rate limiting and abuse controls.
- Encrypted-at-rest or operating-system-protected secret storage.

Acceptance criteria:

- Tokens are bound to the correct client.
- Revocation takes effect without restarting the gateway.
- Brute-force and registration abuse are rate-limited.
- Secrets never appear in logs, tool output, status files, or control-plane URLs.
- Authentication and authorization events are auditable.

### Phase 3 — Minimal Tool Kernel

> Implementation status: complete (2026-08-28) — `core.read`, `core.search`, `core.write`,
> `core.edit`, and `core.exec` (POSIX fixed-command) are implemented. Filesystem tools
> share canonical containment and intrinsic secret-path denial. Writes have a separate
> explicit root, default to dry-run, use optimistic SHA-256 concurrency and atomic
> publication, preserve existing modes, emit attributed secret-free audit events, and
> are covered through authenticated MCP dispatch. `core.edit` performs deterministic
> exact-match replacements against one base snapshot, rejecting missing, ambiguous, and
> overlapping matches, and never creates a file. `core.exec` runs operator-authored
> fixed-command definitions selected by `commandId`, is POSIX-only (Windows is
> fail-closed), never inherits the gateway environment, kills the full process group on
> timeout/abort, and reports a non-zero exit as a result, not an error. See ADR-016 and
> ADR-017. `npm run check` (typecheck, lint, format, 263 tests) and `npm run build` pass on
> Windows Node 24.18.0; `core.exec` remains POSIX-only and fail-closed on Windows.

Deliverables:

- `core.read`
- `core.write`
- `core.edit`
- `core.exec`
- Optional `core.search`
- Shared result, error, truncation, timeout, and cancellation contracts.

Implementation requirements:

- Symlink-aware containment.
- Atomic file replacement.
- Explicit size and output limits.
- Dry-run support for edits and mutations where practical.
- Command parsing without an implicit shell unless explicitly enabled.
- Separate command, subcommand, argument, working-directory, environment, and network policies.
- Secret path deny rules that cannot be overridden by workspace roots.

Acceptance criteria:

- Every tool is independently tested against traversal, symlink, race, size, timeout, and encoding cases.
- Minimal profile exposes no overlapping aliases.
- Write plus execute cannot silently compose into unrestricted code execution.
- Tool results are deterministic enough for automated verification.

### Phase 4 — Policy Engine and live configuration

> Architecture decision: ADR-018 (Versioned immutable policy snapshots and atomic activation).

Deliverables:

- Typed configuration schema.
- Immutable policy snapshots.
- Atomic policy reload.
- Workspace registry.
- Capability profiles.
- Approval hooks.
- Policy decision audit events.

Request flow:

```text
request
  -> authenticate client
  -> resolve workspace
  -> capture policy snapshot
  -> authorize capability
  -> execute
  -> redact output
  -> record audit event
```

Acceptance criteria:

- A configuration update is validated before activation.
- Failed reload retains the previous valid policy.
- The next request sees the new complete snapshot.
- No tool reads authorization rules independently from disk.
- Policy evaluation has a measurable latency budget.

### Phase 5 — Universal MCP Extension Gateway

> Implementation status: complete (2026-08-27). Strict manifests, canonical registry,
> stdio/HTTPS adapters, bounded supervision, policy-only workspace/profile grants,
> request-scoped discovery and dispatch, runtime-generation leases, and secret-free
> extension audit are implemented.
> Linux `npm run check` and `npm run build` pass on Node 22.23.2 and 24.19.0. This phase
> claims process/protocol isolation only, not an OS sandbox, dynamic installation, public
> control plane, remote credential fetching, or discovery-change notifications.

Deliverables:

- Extension manifest schema.
- Canonical namespace registry.
- Stdio and Streamable HTTP adapters.
- Child Process Supervisor.
- Startup, readiness, timeout, backoff, restart, shutdown, and quarantine states.
- Request-scoped ready-and-authorized tool discovery.
- Policy workspace/profile grants plus provider-scoped environment and credential refs.
- Bounded queue, restart/quarantine, and health state.

Acceptance criteria:

- One failed extension cannot terminate the gateway.
- Tool-name collisions fail configuration validation.
- Extension restart does not rename healthy tools.
- Unhealthy extensions are removed or marked unavailable predictably.
- Credentials are scoped to the extension that needs them.
- Resource limits and output limits are enforced.
- Malformed discovery or provider tool drift fails closed before exposure.
- Reload cannot mix policy/registry/runtime generations or stop an active exchange.
- Extension errors and audit records do not disclose arguments, output, endpoints,
  environment data, credential references, or raw provider errors.

### Phase 6 — Project context and instruction system

> Implementation status: complete (2026-08-28). Operator policy explicitly declares
> user, workspace, and directory instruction sources plus file/context budgets. Authenticated
> clients load provenance through an MCP resource and request content through an MCP prompt;
> instruction text is untrusted user context and never grants capability. Linux acceptance
> passes on Node 22.23.2 and 24.19.0; Windows `npm run check` and `npm run build` pass on
> Node 24.18.0 (2026-08-28). Optional one-time onboarding remains deferred.

Deliverables:

- Explicit project-file discovery.
- Precedence rules for user, workspace, and directory instructions.
- Context budget and truncation rules.
- Content hash/version reporting.
- Client-visible provenance.
- Optional one-time onboarding state.

Acceptance criteria:

- Instruction content is never described as a system-prompt override.
- The client can see which files influenced the context.
- Large instructions are referenced or selectively loaded instead of repeated.
- Instruction files cannot grant capabilities.
- Missing or malformed files fail safely.

### Phase 7 — Control plane and observability

> Implementation status: complete (2026-08-28). A distinct owner-authenticated control
> listener is restricted to loopback IP literals; the public MCP router has no control
> routes. It provides redacted policy/workspace/capability and extension-health views,
> owner-approved atomic reload, client/token revocation, bounded audit export, and fixed-name
> operational metrics. Telemetry is independently disableable. Linux `npm run check` and
> `npm run build` pass on Node 22.23.2 and 24.19.0 with 307 passed / 1 skipped (308 total).
> Phase 7 Windows evidence is not claimed by this checkpoint. See ADR-021.

Deliverables:

- Loopback-only local control plane by default.
- Workspace and capability management.
- Extension lifecycle view.
- Client and token revocation.
- Structured logs.
- Metrics for Latency, errors, queue depth, restarts, memory, and tool usage.
- Privacy-preserving audit export.

Acceptance criteria:

- The public data plane cannot serve control-plane pages.
- Sensitive values are redacted at their source.
- Audit events identify client, workspace, capability, policy version, result, and duration.
- Telemetry can be disabled without breaking operation.

### Phase 8 — Standalone distribution

> Implementation status: Linux x64 SEA prototype, verified manifest fetch, versioned
> install, atomic activation/rollback, and CI artifact verification are implemented.
> Node 22/24 gates pass with 326 tests passed / 1 skipped; Linux x64 SEA help,
> version, checksum, and deny-all bootstrap smoke pass. Cross-target native evidence and real-client OAuth-to-tool verification remain release
> gates; unsupported targets are not claimed.

The standalone objective is a self-contained user experience, not a promise that the application has no internal dependencies.

Workstream A — non-developer runtime:

- No system-wide Node.js, npm, Git, or repository checkout requirement.
- Native HTTP download and update flow.
- Versioned installation directories.
- Pinned artifacts and SHA-256 verification.
- Atomic activation and rollback.
- Clear separation from the repository developer workflow.

Workstream B — single-executable prototype:

1. Bundle the TypeScript application and required assets.
2. Build one Node SEA target.
3. Verify dynamic imports, worker/child processes, certificates, static assets, and native modules.
4. Measure cold start, RAM, size, update cost, and signing behavior.
5. Expand only after one target passes end-to-end.

Target matrix:

- Linux x64
- Linux arm64
- Windows x64
- macOS x64
- macOS arm64

Acceptance criteria:

- CI produces deterministic, checksummed assets.
- Each supported target boots on a clean machine.
- The full OAuth-to-tool path is verified on real clients.
- Signing/notarization requirements are documented.
- Release publication is blocked when required assets or verification records are missing.
- Documentation does not claim single-executable support before these criteria pass.

### Phase 9 — Hardening and stable release

> Implementation status: core complete (2026-08-28) — MCP conformance (initialize negotiation, unsupported-version rejection, malformed JSON-RPC/batch/unknown-method, invalid UTF-8/media-type, stateless isolation), input/body boundary (hard byte limit + fatal UTF-8), release-manifest URL/path/hostile-mutation rejection, manifest-fetch fail-closed, standalone update recovery (stream reset, disk/rename/activation faults via injected I/O seam, rollback), and gateway bootstrap cleanup are implemented and covered by `tests/conformance` plus `tests/unit/{bootstrap,standalone-installer,manifest-fetch,release-manifest}`. `npm run check`: Windows 320 passed / 27 skipped; Linux 346 passed / 1 skipped. GitHub Actions `ci.yml` (Node 22/24 + benchmark baseline) and `standalone.yml` (Node 22/24 quality gate to SEA build/verify) pass. Cross-platform native builds, signing/notarization, and OAuth-to-tool real-client remain follow-on scope, not claimed by this phase.

Deliverables:

- Threat model.
- Security review.
- Protocol conformance report.
- Performance baseline.
- Upgrade and rollback tests.
- Failure-injection tests.
- Backup and recovery documentation.
- Stable compatibility policy.

Release gates:

- No unresolved critical security findings.
- No secret exposure in logs or error paths.
- Protocol compatibility matrix passes.
- Cross-platform CI and required manual checks pass.
- P95 and P99 Latency budgets are recorded.
- Memory and cold-start budgets are evidence-based.
- Upgrade from the previous supported version is recoverable.

## 7. Performance and Scalability targets

Initial targets are hypotheses until measured.

| Metric | Measurement |
| --- | --- |
| Core tool overhead | P50/P95/P99 gateway-added Latency |
| Cold start | Process start to readiness |
| Memory | Idle, one client, concurrent clients, extension load |
| Concurrency | Sustained requests and saturation behavior |
| Extension recovery | Failure to healthy restart time |
| Policy reload | Validation and atomic activation time |
| Artifact size | Per OS/architecture |
| Context cost | Tokens added per request/session |

Benchmark rules:

- Record hardware, OS, Node version, build mode, protocol revision, client type, and policy profile.
- Separate SDK/runtime baseline from project code.
- Compare before and after every optimization.
- Do not trade protocol correctness or isolation for a cosmetic RAM target.

## 8. Major risks

| Risk | Mitigation |
| --- | --- |
| Protocol evolution | Dual-era adapter, versioned conformance suite |
| Extension escape | Process isolation, scoped environment, OS sandbox where available |
| Write plus execute escalation | Capability separation and policy composition checks |
| Secret exposure | Hard deny paths, output redaction, no secret-bearing logs |
| Shared-session data leak | Session isolation and stateless modern path |
| Tool Fingerprinting or collisions | Canonical registry and deterministic namespace |
| Configuration drift | Typed schema, immutable snapshots, status versioning |
| Packaging complexity | Prototype gates and per-target CI |
| Context inflation | Explicit provenance and context budgets |
| Gateway overload | Backpressure, timeouts, queues, circuit breakers |

## 9. Definition of done

A phase is complete only when:

- Code is implemented.
- Tests pass.
- Security-sensitive behavior is reviewed.
- Runtime verification is recorded.
- Documentation matches actual behavior.
- Metrics exist for performance claims.
- Upgrade and rollback impact is known.
- No temporary compatibility or security bypass remains undocumented.

## 10. Immediate next steps

1. Confirm the Apache-2.0 copyright holder string.
2. Initialize the TypeScript repository.
3. Write ADR-006 for modern and legacy MCP compatibility.
4. Define the canonical tool and extension manifest schemas.
5. Build the minimal protocol spike before implementing tools.
6. Create the threat model before enabling filesystem writes or command execution.
