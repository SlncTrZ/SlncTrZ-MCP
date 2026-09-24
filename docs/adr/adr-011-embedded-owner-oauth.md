# ADR-011: Embedded owner-only OAuth for Phase 1 dogfood

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

> Current-contract note (2026-09-24): this ADR records the original Phase 1 bootstrap. The current v0.3.5 contract persists dynamic client registrations in the managed state file, persists grant families/access+refresh token hashes/client-default profiles in the OAuth SQLite store, and keeps only pending authorization transactions and authorization codes in memory. A normal gateway restart therefore preserves acknowledged clients and durable grants/tokens but drops unfinished authorization transactions/codes. The current durability contract supersedes the historical restart statements below; the owner-only/single-process and strict PKCE/redirect/resource-binding decisions remain active.

## Context

The Phase 1 public MCP endpoint must connect to web clients without allowing anonymous
tool execution. The gateway is also moving toward a standalone distribution, so the
first dogfood release cannot assume a separately installed identity provider. MCP
authorization requires protected-resource and authorization-server discovery, OAuth
authorization-code flow, PKCE, resource binding, and access-token verification.

This is a narrow bootstrap decision for a single owner. It is not the final multi-user
identity architecture.

## Decision

Run a small OAuth authorization server in the gateway process for Phase 1 dogfood:

- publish RFC 9728 protected-resource metadata and authorization-server metadata;
- accept dynamic registration for public clients only;
- require authorization code with PKCE S256 and exact redirect/resource binding;
- require the owner passphrase at the consent step, verified against a runtime-only
  scrypt verifier;
- issue opaque, short-lived access tokens and rotating refresh tokens;
- verify expiry, resource, client, and scope before MCP dispatch;
- rate-limit registration and token exchange by direct peer; Owner-authentication failure budgeting is refined by ADR-013.

Historical Phase 1 statement (superseded): clients, pending grants, authorization codes,
and tokens were originally in memory and a process restart invalidated them. Runtime
hostname, public URL, and owner verifier remain outside tracked source.

Current v0.3.5 state is deliberately split:

- dynamic client registrations are durable managed state;
- grant families, token hashes, grant profiles, labels, and client-default profiles are durable SQLite state;
- pending authorization transactions and authorization codes remain bounded in-memory state;
- raw bearer/refresh credentials are not persisted as plaintext.

Multi-user accounts, federation, and external identity-provider integration remain out
of scope for this owner-only design. Token revocation and durable grant-family state are
now implemented by later work and ADR-012's current-contract note.

## Consequences

- **Positive:** Phase 1 can be exercised end-to-end with real OAuth-capable MCP clients
  while remaining self-contained and default-deny.
- **Negative / costs:** unfinished authorization transactions/codes are intentionally lost
  on restart; one process owns live authorization flow state; this design is unsuitable
  for horizontal scaling without a new shared-state design.
- **Risks and mitigations:** brute-force and allocation abuse are bounded by the rate-limit
  model refined in ADR-013, short lifetimes, strict input limits, and opaque credentials. The public
  endpoint must remain behind HTTPS ingress. A later ADR must replace or persist the
  authority before multi-user or high-availability operation.

## Alternatives considered

Use an external identity provider immediately. This gives stronger operational
maturity, but adds a deployment dependency before the transport and client
compatibility path has been proven.

Accept a static bearer token. This does not provide browser authorization, PKCE, client
registration, or standards-based discovery and was rejected.

## Verification

- `npm run check`
- discovery metadata tests;
- DCR and redirect-policy tests;
- PKCE, code replay, resource, scope, and expiry tests;
- refresh-token rotation tests;
- HTTP 401 challenge and authenticated MCP tests;
- owner-secret non-reflection and rate-limit tests;
- public HTTPS probe followed by ChatGPT, Claude, and Grok connection evidence.
