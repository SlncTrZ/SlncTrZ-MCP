# ADR-030: Owner-issued Host Tokens

Status: Accepted by Owner on 2026-10-14. Source implementation; release and installed-client acceptance are separate gates.

## Context

OpenCode, Pi, Claude, Codex and headless workloads may support a bearer header without
reliable OAuth browser/refresh handling. Each workload needs its own revocable identity.
Existing OAuth authorization-code + PKCE, loopback redirects and refresh rotation remain supported.

## Decision

- Issue a random 256-bit `hst_` bearer credential, returning the secret only in the issue
  response. Persist SHA-256 only; list and audit never return the secret or its hash.
- No fixed expiry. At authentication, reject and delete a credential whose inactivity is
  **greater than or equal to 15 days**. The anchor is its latest successful authentication,
  or issuance if unused. Failed authentication does not extend the anchor. Tool/protocol
  errors after successful authentication still count as authenticated use.
- Map each credential to `host:<tokenId>`, with hard-coded `mcp:tools`, `gateway-only`
  and structured results. OAuth client defaults and Owner grant profile mutations cannot
  elevate it. Apply the existing profile filter to both discovery and dispatch.
- Gateway-only exposes `core.ping`, available Debate tools and Owner-enabled provider
  tools. It hides coding/file/media/context/skills/task tools. A bearer does not grant
  Owner authority, nor authority beyond the gateway's active provider policy.
- Store in `<stateRoot>/secrets/host-tokens.sqlite3`, with separate `host_tokens`
  and `host_token_audit` tables. It is a new companion database: OAuth's schema and
  `user_version=3` stay unchanged. An older binary ignores the new file and rejects
  Host Tokens. Re-upgrading restores still-active rows; the auth path still checks inactivity.
- Use SQLite `BEGIN IMMEDIATE` for authentication/touch, deletion and audit insertion.
  A request authenticated before revoke commits may finish; every subsequent authentication
  fails. Revoke cannot be undone by stale request/cleanup state.
- Keep credential storage bounded to 64 live rows, without eviction. Audit retains the
  newest 250,000 metadata events independently of credential deletion, matching the
  existing audit row budget. Events: `issued`, `used`, `revoked`, `inactive_15d`;
  fields: tokenId, event, actor, timestamp. No bearer or hash appears in audit.
- Check inactivity in every `/mcp` authentication, regardless of restart/downtime.
  Startup and Owner management prune idle rows as housekeeping; no cron is required.
- Owner Console uses its existing session + CSRF. Loopback CLI uses existing Owner
  control authentication. Issue accepts only a label, revoke/delete only a token ID:
  no scopes, Full profile or expiry overrides are accepted.
- Enforce private file/sidecar permissions and Windows ACLs; reject file/sidecar and
  immediate parent directory symlinks. Startup fails closed if the store cannot open.
  Drain listeners before closing the store; close on initialization failure too.

## Consequences

Each client can authenticate without a browser, redirect or refresh exchange. It needs
reissuance after 15 days unused. A stolen bearer can keep itself active, so inactivity
does not replace secret protection or Owner revoke. Bearers are not bound to IP/device.

The authority ceiling is a tool surface, not an OS sandbox. Provider tools may expose
powerful operations according to Owner policy. Protect client storage and backups;
use HTTPS for remote requests. Never paste a bearer into chat, logs, a repository or KB.

Restoring an older backup can restore previously deleted rows. Reconcile/revoke affected
tokens before exposing a restored installation. Binary rollback alone does not erase
the companion database or its audit.

## Evidence and remaining gates

`tests/unit/host-token-store.test.ts` covers boundaries, active use over years, failed auth,
restart/downtime, audit retention, multi-connection revoke/prune, capacity, permissions
and symlinks. `tests/conformance/host-token-e2e.test.ts` covers authenticated HTTP,
discovery/dispatch restrictions, provider access, Owner/CSRF/CLI and OAuth compatibility.
`tests/unit/bootstrap.test.ts` verifies the shared store across full application restart.

On 2026-10-14, native Linux and Windows each passed 18/18 installed artifact checks:
clean User Install, QA-signed update, tamper rejection, restart, rollback/re-upgrade,
Host Token enforcement and preserved OAuth state. These used ephemeral QA signing keys
and isolated state, not official publisher credentials. Windows OpenCode 1.19.0 and
Linux OpenCode 2.0.28 each completed two fresh Host Token discovery cycles with eight
authenticated requests; QA tokens were revoked afterward.

Official signing/CI/release, other named clients and existing OAuth two-reopen field
acceptance remain separate OPEN gates. The Host Token discovery checks invoked no LLM
and do not certify availability of the configured model.

Additional native QA on 2026-10-14/15: Owner Console passed 11/11 browser checks per OS
against the real backend, including registry reload failure preservation. Pi 1.2.0 on Windows
passed two Host Token discovery cycles. Linux OpenCode 2.0.28 API and MCP CLI onboarding
passed PKCE, two fresh OAuth reconnect cycles and refresh recovery after forced access expiry.
All used disposable state; existing mixed-store migration and production field acceptance
remain OPEN. No new product source change was needed for these exercised paths.
