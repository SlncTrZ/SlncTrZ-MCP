# ADR-011: Embedded owner-only OAuth for Phase 1 dogfood

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

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
- rate-limit registration, token exchange, and owner authentication by direct peer.

Clients, pending grants, authorization codes, and tokens are in memory. A process
restart invalidates them. Runtime hostname, public URL, and owner verifier remain
outside tracked source.

Persistent identity, multi-user accounts, federation, token revocation, and external
identity-provider integration are explicitly out of scope for this decision.

## Consequences

- **Positive:** Phase 1 can be exercised end-to-end with real OAuth-capable MCP clients
  while remaining self-contained and default-deny.
- **Negative / costs:** clients must reconnect after restart; one process owns all
  authorization state; this design is unsuitable for horizontal scaling.
- **Risks and mitigations:** brute-force and allocation abuse are bounded by direct-peer
  rate limits, short lifetimes, strict input limits, and opaque credentials. The public
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
