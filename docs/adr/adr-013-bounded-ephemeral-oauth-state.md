# ADR-013: Bound ephemeral OAuth allocations

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

## Context

PLAN Phase 2 requires registration and brute-force abuse controls. Per-peer rate limits
bound allocation speed but do not bound long-running memory use: dynamic client records
have no standardized expiry, and authorization requests allocate pending transactions.
A fixed client expiry would silently invalidate otherwise valid public clients.

## Decision

- Limit dynamic clients to a configurable `SLNCTRZ_MAX_DYNAMIC_CLIENTS` value, defaulting
  to 1024.
- Never count or evict pre-registered confidential clients.
- When the dynamic-client pool is full, evict the least-recently-used client that has no
  pending authorization, authorization code, access token, or refresh token.
- If every dynamic client has live authorization state, reject registration with HTTP 429
  instead of invalidating an active grant.
- Rate-limit authorization initiation independently from registration, token exchange,
  revocation, and owner-passphrase attempts.
- Audit capacity evictions and rate-limit decisions without recording request bodies,
  redirect parameters, credentials, or tokens.

## Consequences

- **Positive:** OAuth state has a hard client-cardinality bound without arbitrary client
  expiry, and authorization floods cannot grow pending state at an unbounded rate.
- **Negative / costs:** an inactive client may need to register again after eviction.
- **Risks and mitigations:** direct-peer rate limiting can be coarse behind one ingress
  process. The global dynamic-client bound remains effective independently of peer identity.

## Alternatives considered

Assign a fixed lifetime to dynamically registered client IDs. RFC 7591 does not define a
client-ID expiry response field, so hidden expiry was rejected.

Persist every dynamic client. This moves allocation pressure to disk and introduces a
sensitive state lifecycle that ADR-012 intentionally defers.

## Verification

- Unit tests prove active clients are not evicted and inactive clients are evicted first.
- HTTP tests prove registration and authorization allocation limits return 429 and emit
  structured audit events.
- Configuration tests prove the runtime capacity is a positive safe integer.
- `npm run check` and a production build must pass.
