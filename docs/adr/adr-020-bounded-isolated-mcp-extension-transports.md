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

This decision implements the transport and lifecycle boundary described by PLAN Phase 5
and ARCHITECTURE §4.11. Policy selection, discovery and MCP dispatch remain separate
slices.

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
  provider once exhausted. A failed or quarantined provider cannot block the core.
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
  timeout, queued cancellation, active-stop settlement, failed restart quarantine, stderr
  overflow, same-origin HTTPS redirects and streamed response limits.
- `npm run check` and build must pass on Node 22 and Node 24 on Linux before Phase 5
  acceptance. Windows evidence is compile/test only for the cross-platform code paths.
- Authenticated policy/discovery/dispatch and secret-free extension audit remain required
  before Phase 5 can merge to `master`.
