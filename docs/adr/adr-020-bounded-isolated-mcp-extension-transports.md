# ADR-020: Bounded isolated MCP extension transports

> Status: Accepted
> Date: 2026-08-27
> Owners: SlncTrZ

## Context

Phase 5 connects operator-declared third-party MCP providers to a trusted gateway. A
provider is less trusted than the gateway: it may fail, flood output, stall, redirect a
network request, or receive model-supplied arguments. The gateway must preserve one
canonical namespace and prevent one provider from exhausting core resources or obtaining
gateway credentials.

This decision covers the transport/lifecycle boundary and its integration with the Phase 4
policy snapshot, authenticated discovery, MCP dispatch, reload retirement, and audit as
described by PLAN Phase 5 and ARCHITECTURE §4.11.

## Decision

- An extension is compiled only from a strict, operator-owned manifest. It has a stable
  provider ID, namespaced canonical tool IDs, fixed transport configuration and bounded
  startup, request, message, output, queue and restart limits.
- Stdio providers run as child processes with `shell: false`, a fixed absolute command
  and fixed argv, a command-directory working directory, and an explicit environment
  containing only `PATH` and manifest-allowlisted variables. They do not inherit the
  gateway environment.
- Streamable HTTP providers use a fixed HTTPS endpoint. Redirects may remain only on the
  same HTTPS origin. Endpoint credentials, query strings and fragments are rejected.
- Both transports bound protocol messages and returned text by bytes, map failures to
  stable non-sensitive adapter errors, and release pending work on stop or transport
  failure.
- A supervisor serializes one provider's calls behind a bounded queue, propagates
  cancellation, hard-bounds requests, uses a finite restart budget and quarantines a
  provider once exhausted. Every start/restart must attest the provider's exact declared
  canonical tool set; malformed discovery or drift leaves it unavailable.
- Manifests are capability/transport declarations, never authorization grants. The
  operator-owned policy document is the single workspace/profile authorization source.
  Authenticated discovery exposes only `authorized ∩ ready` tools.
- Each MCP exchange captures one immutable policy/runtime generation. Dispatch remains
  bound to that snapshot's canonical authorization, rechecks readiness, and never falls
  back by name. An activated reload retires
  the prior runtime only after its active exchange leases release; invalid/colliding
  candidates keep the exact previous snapshot, and valid non-activated candidates retire
  their eagerly started runtime.
- Extension audit has a fixed secret-free schema: attribution, policy version, provider,
  canonical tool, risk, result, and duration only. It cannot carry args, output, endpoint,
  environment data, credential refs, manifest text, or raw provider errors.
- This is process and protocol isolation, not an OS sandbox. Extensions may still have
  the operating-system permissions of the gateway identity. No container, network
  namespace, dynamic provider installation, public control plane or credential fetching
  is introduced here.

## Consequences

- **Positive:** fixed execution/network destinations, bounded resource use, deterministic
  provider failure behavior and a small trusted adapter surface.
- **Negative / costs:** a provider using cross-origin redirects, inline endpoint query
  configuration or unrestricted environment inheritance cannot be used without an
  explicit future design change.
- **Risks and mitigations:** child-process isolation does not replace OS sandboxing;
  operators must use a restricted service identity and apply sandboxing before accepting
  untrusted code or broad filesystem/network access.

## Alternatives considered

- **Run third-party MCP logic in-process:** rejected because a crash or dependency can
  compromise trusted gateway availability and memory.
- **Allow arbitrary redirects or caller-selected endpoints:** rejected because it defeats
  the fixed operator-controlled network destination.
- **Unlimited retries/output queues:** rejected because a single faulty provider can
  create unbounded latency and memory pressure.
- **Claim container sandboxing now:** rejected because no such enforcement mechanism is
  implemented.

## Verification

- Unit and real child-process tests cover manifest rejection, immutable registry records,
  collision retention, malformed/tool-drift discovery, no inherited environment, timeout,
  queued cancellation/overload, active-stop settlement, reload lease drain, crash-loop
  quarantine, stderr/output overflow, same-origin HTTPS redirects, streamed response
  limits, authenticated policy/discovery/dispatch, stable unavailable errors, and
  credential/audit redaction.
- On 2026-08-27, `npm run check` and `npm run build` passed in Linux containers on Node
  22.23.2 and Node 24.19.0. `git diff --check` passed and the lockfile did not change.
- Windows execution/isolation evidence is not claimed by this checkpoint. Windows
  compile/fail-closed coverage remains a release/merge evidence item where applicable.
