# MCP Provider Standard

Desired technical baseline for owner-added providers. This is an integration requirement,
not a certification that every external provider already satisfies it.

## 1. Transport & Discovery

Use supported STDIO or Streamable HTTP. Modern server/discover negotiation falls back to
supported legacy initialization. Provide self-describing help/capability tools; agents use the
actual runtime catalog rather than assuming a help name, tool count or installed version.

Tool IDs are namespaced by provider ID in the gateway. A provider process/endpoint must
already be installable/reachable with the configured OS account and credentials.

## 2. Error Handling & Invariants

- Return bounded structured errors; redact credentials and request payloads.
- Do not replay uncertain mutations automatically after transport/session failure.
- Release owned OS resources on normal shutdown/timeout and document forced-kill limits.
- Define atomic mutation or explicit recovery/rollback semantics in the provider contract.
- Verify native application readiness and ownership-safe stop in the provider's own acceptance suite.

The gateway bounds calls and supervises STDIO children; it does not sandbox provider authority
or guarantee cleanup of independent remote applications. See [MCP Servers](MCP_SERVERS.md).
