# ADR-021: Separate loopback owner control plane and bounded telemetry

> Status: Accepted
> Date: 2026-08-28
> Owners: SlncTrZ

## Context

Phase 7 needs local policy operations, extension health, revocation, metrics, and audit export
without expanding the public MCP attack surface. Reusing the public HTTP listener or accepting
free-form telemetry labels would expose administrative routes through ingress and create
credential, Fingerprinting, Cardinality, and memory risks.

## Decision

- The control plane is a separate Node HTTP server and may bind only to the literal loopback
  addresses `127.0.0.1` or `::1`. It is never mounted on the public data-plane router.
- Every control request requires the existing owner verifier through an Authorization bearer
  header. Authentication failures are bounded per direct peer; responses are JSON, bounded,
  `no-store`, and never reflect credentials.
- Read-only routes expose policy version, redacted workspace/profile/capability/grant views,
  extension state/health, fixed-name metrics, and a bounded chronological audit export. Roots,
  commands, arguments, output, endpoints, environment values, credential references, raw
  authorization headers, and token values are excluded.
- The operator-owned policy file remains the configuration source. The control plane can
  owner-approve one complete candidate reload; parsing, validation, risk classification,
  immutable snapshot construction, atomic activation, and failed-candidate retention remain
  in the policy store. There is no free-form control-plane policy editor.
- Owner-authorized client revocation removes that client's ephemeral authorization state and
  grants; token revocation removes the complete grant family. Token material is accepted only
  by the bounded revocation body and is never retained in audit.
- Authentication, policy, tool, and control events fan out to existing JSONL sinks plus one
  bounded in-memory journal whose runtime projection contains only reviewed fields.
- Operational metrics use fixed fields and bounded latency samples. Tool calls are measured
  at the common MCP registration seam; policy reloads at the outer transaction; extension
  restart, quarantine, and queue depth at real supervisor transitions. Metrics include
  P50/P95/P99 latency, active/queued requests, errors, truncation, restarts, quarantine,
  policy-reload duration, authentication failures, resident memory, and CPU.
- `SLNCTRZ_TELEMETRY_ENABLED=false` removes runtime metrics instrumentation and the metrics
  route without changing authentication, policy, MCP, extension, or audit operation.
- Persistent audit storage, remote administration, a browser UI, direct policy-file mutation,
  and TLS termination on the loopback listener are out of scope.

## Consequences

- **Positive:** public ingress cannot reach administrative routes; owner mutations reuse
  existing fail-closed policy and OAuth mechanisms; telemetry is bounded and privacy-reviewed.
- **Negative / costs:** the journal is process-local and lost on restart; operators still edit
  the policy file through an external protected workflow before requesting reload.
- **Risks and mitigations:** local processes sharing the service identity may reach loopback,
  so owner authentication remains mandatory. Bearer credentials must come from a protected
  local client and never be placed in URLs or logs.

## Alternatives considered

- **Serve `/admin` from the public listener:** rejected because ingress or routing drift could
  expose the control plane.
- **Accept arbitrary metric labels or audit payloads:** rejected because caller/provider data
  creates leakage and unbounded Cardinality.
- **Let the control plane patch policy fragments directly:** rejected because it would bypass
  the operator-owned document, complete validation, risk summary, and atomic snapshot boundary.
- **Persist raw audit events in-process:** rejected because retention, encryption, rotation,
  and access control require a separate storage decision.

## Verification

- Tests cover loopback-only bind, owner authentication, rate limiting, no-store/generic errors,
  redacted status/policy/metrics/audit, telemetry-disabled behavior, bounded mutation bodies,
  owner-approved atomic reload, client/token revocation, token redaction, journal retention,
  MCP tool instrumentation, latency bounds, queue balance, and real supervisor transitions.
- On 2026-08-28, `npm ci`, `npm run check` and `npm run build` passed in Linux containers
  with an init reaper on Node 22.23.2 and Node 24.19.0. The suite reported 307 passed and one
  Windows-only test skipped (308 total). `git diff --check` passed; the lockfile did not change.
- Phase 7 Windows runtime evidence is not claimed by this checkpoint.
