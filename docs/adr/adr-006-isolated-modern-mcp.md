# ADR-006: Isolated Modern MCP with Stateless Legacy Compatibility

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

## Context

PLAN Phase 1 requires modern request-context isolation while retaining compatibility
with clients that still negotiate a 2025 MCP revision. Sharing one negotiated server or
transport across clients would violate ARCHITECTURE security-context isolation and make
horizontal Scalability depend on global in-memory state.

## Decision

Use the official MCP TypeScript SDK v2 and its per-request server factory.

- Serve Streamable HTTP at `/mcp`.
- Create a fresh `McpServer` for every modern request exchange.
- Serve 2025-era clients through the SDK's stateless legacy fallback from the same
  factory, so tool definitions cannot drift between protocol eras.
- Do not implement shared legacy sessions in Phase 1.
- Keep OAuth and authenticated client identity in Phase 2; Phase 1 exposes transport
  compatibility only.
- Guard the Node HTTP edge with explicit Host and Origin allowlists, request size
  limits, and generic public errors.

## Consequences

- **Positive:** negotiated state cannot leak between clients; modern requests remain
  horizontally routable; one tool factory serves every supported protocol era.
- **Negative / costs:** stateless legacy clients cannot rely on server-side session
  continuity; remote ingress needs an explicit hostname allowlist.
- **Risks and mitigations:** unauthenticated public exposure is unsafe, so production
  remote use remains blocked until Phase 2 authentication is complete.

## Alternatives considered

- A shared `McpServer` and transport was rejected because it couples clients through
  mutable negotiated state.
- Stateful legacy sessions were deferred because they add lifecycle and identity state
  before Phase 2 can bind that state to authenticated clients.
- A custom protocol implementation was rejected because the official SDK already
  provides the required conformance boundary with lower maintenance risk.

## Verification

- `npm run check`
- HTTP tests prove health routes, 2025 negotiation, tool listing/call, Host rejection,
  and the 16 MiB bounded request-body limit.
- Real-client verification with Claude, ChatGPT, and Grok is recorded separately once
  authenticated HTTPS ingress exists.
