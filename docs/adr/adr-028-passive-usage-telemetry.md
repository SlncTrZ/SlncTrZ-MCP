# ADR-028: Passive usage telemetry and context-savings dashboard

- **Status:** Accepted for v0.3.1
- **Date:** 2026-09-11

## Context

SlncTrZ-MCP already controls the MCP boundary and the progressive-disclosure harness, but users cannot see how much context actually moves through the gateway or how much context the harness avoids loading eagerly.

The product needs usage visibility without turning telemetry into a new authority layer, without storing prompts/tool payloads, and without coupling the gateway to one model vendor or one tokenizer.

## Decision

1. Usage telemetry is an **observability-only** subsystem. It never authorizes, denies, retries, replays, throttles, or mutates a tool call.
2. MCP request/response byte counts are observed at the common HTTP boundary. Exact UTF-8/wire body bytes are retained only as numeric counts.
3. Token values use a versioned model-neutral estimate (`utf8-bytes-v1`, approximately four UTF-8 bytes per token). They are labeled as estimates, not provider billing truth.
4. Usage history is stored separately in `<stateRoot>/usage.sqlite3`. It does not extend `audit.sqlite3` or `ToolAuditEvent`.
5. No prompt, tool arguments, file content, command output, provider payload, credential, bearer token, or context receipt is persisted.
6. The coding harness records a progressive-disclosure baseline per context: bootstrap context plus every active `SKILL.md` body as the hypothetical eager-load case. Skill bodies actually activated are added to the disclosed amount. Referenced resources are measured as ordinary gateway traffic but are not included in the eager baseline.
7. `/usage` is a read-only page. Its data APIs stay under `/owner/api/usage/*` and reuse the existing Owner Console session. The Owner cookie remains scoped to `/owner`.
8. Telemetry is fail-open. Store initialization, queueing, persistence, estimation, or dashboard failures must not fail normal MCP work.
9. Storage and queries are bounded. v0.3.1 keeps 90 days by default and caps persisted event/context rows.
10. Cost estimates use an owner-entered input-token price in the browser. Vendor pricing is not hard-coded into the gateway.

## Consequences

- Users can see observed gateway traffic, per-tool context cost, progressive-disclosure efficiency, and an estimated cost avoided.
- The feature remains vendor-neutral and privacy-minimal.
- The gateway can continue operating if `usage.sqlite3` is unavailable.
- Reported token and dollar values are intentionally approximate. Exact provider billing still requires provider-side usage data, which is outside v0.3.1 scope.
- The usage database is operational history, not an authorization record; audit and usage retain separate semantics and backup choices.
