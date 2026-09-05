# ADR-025: Loopback HTTP exception for streamable-http MCP endpoints

> Status: Accepted
> Date: 2026-08-31
> Owners: SlncTrZ-MCP

## Context

Adding an MCP provider through the Owner Console returns `rolled_back` with
`failedStep: "provider_probed"` for every `http://127.0.0.1:<port>/mcp` endpoint
(e.g. pi-core at `http://127.0.0.1:3003/mcp`). The provider is not persisted.

Root cause: the streamable-http transport is **HTTPS-only by design** and this is
enforced at two layers — `src/extension/manifest.ts` (`HTTP endpoint must use HTTPS`)
and `src/extension/streamable-http-adapter.ts` (`http adapter requires https`). A
loopback `http://` endpoint never reaches the network probe; it fails at construction,
so the orchestrator records `provider_probed` and rolls back cleanly.

Local MCP servers (stdio or streamable-http on loopback) are the standard pattern for a
local-first gateway. Refusing every non-HTTPS endpoint makes these internal providers
impossible to register. We need a **controlled exception** — not a global relaxation.

## Decision

Allow `http:` only when the endpoint host is a **loopback address**, detected by a
single helper `isLoopbackHost()`:

- IPv4 loopback range `127.0.0.0/8` (RFC 1122 §3.2.1.6)
- `localhost` and `.localhost` subdomains (RFC 6761)
- IPv6 loopback `::1` (and its compressed / IPv4-mapped forms)

Implemented in `src/extension/loopback.ts` and applied at both enforcement points
(manifest compilation and adapter construction). The check is **purely per-host**.

**Per-provider origin binding is unchanged and is the real isolation boundary.** The
adapter is bound to exactly one `manifest.endpoint`; every request starts from that
`base` URL and redirects must remain **same-origin** (`next.origin === origin`, and
`origin` includes scheme + host + **port**). Therefore a provider registered for
`http://127.0.0.1:3003/mcp` can only ever reach `127.0.0.1:3003` — never another port
(`:3004`), another host, or an https downgrade. The redirect guard was relaxed from
`next.protocol !== "https:" || next.origin !== origin` to `next.origin !== origin`,
which is equivalent for HTTPS origins (a scheme change is already an origin change)
and necessary for loopback-http same-origin redirects (e.g. `/mcp` → `/mcp/`).

"Endpoint exists" is enforced by the probe, not by the scheme gate: a loopback-http
endpoint that is not actually listening fails `provider_unavailable` at `adapter.start()`
and the orchestration still rolls back.

### Explicitly out of scope

- No global http:// relaxation for non-loopback hosts.
- No change to the stdio transport, policy engine, or credential handling.
- No change to the public HTTPS endpoint path (cloudflared / `mcp.example.com`).

## Consequences

- **Positive:** local streamable-http MCP servers on loopback can now be registered
  and persisted; production HTTPS endpoints behave exactly as before.
- **Negative / costs:** a small, deliberately narrow surface (loopback only) is now
  allowed over cleartext HTTP. This is bounded to the machine's own loopback interface
  and cannot be reached from the network.
- **Risks and mitigations:** an operator could point a provider at a loopback port of a
  non-MCP local service (local SSRF). Mitigation: the provider is bound to one fixed
  origin and the probe must complete the MCP handshake and enumerate tools before the
  provider is persisted; a non-MCP service fails the probe and rolls back.

## Alternatives considered

- **Write a tunnel to expose pi-core over HTTPS** (cloudflared) — no code change, but
  adds external dependency and operational complexity, and was not available for port 3003.
- **Abandon loopback-http registration** — avoids the problem but leaves a common
  local-first MCP pattern unsupported.
- **Allow http:// globally** — rejected: broadens the transport surface beyond the
  loopback interface, which is exactly the uncontrolled relaxation this ADR avoids.

## Verification

- `tests/unit/loopback.test.ts` — `isLoopbackHost` accepts loopback forms and rejects
  non-loopback host names.
- `tests/unit/extension-manifest.test.ts` — loopback-http manifest compiles;
  `http://x.example.com` / `http://192.168.1.10` still rejected.
- `tests/unit/streamable-http-adapter.test.ts` — loopback-http endpoint constructs and
  completes the modern MCP handshake; a redirect to a different loopback port is
  rejected (`provider_protocol_error`).
- `npm run check` passes (typecheck + lint + vitest).
