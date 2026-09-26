# ADR-012: Grant-family token revocation and redacted authentication audit

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

> Current-contract note (2026-09-24): the revocation/audit decisions remain active, but the historical in-memory token durability statements are superseded. v0.3.5 stores grant families and token hashes in the OS-protected OAuth SQLite store; dynamic clients are durable managed state; pending authorization transactions and authorization codes remain in memory. The store persists hashes/metadata, not plaintext bearer/refresh credentials. Durable auth audit also persists privacy-reviewed operation/reason enums.

## Context

PLAN Phase 2 requires an explicit token revocation lifecycle, immediate revocation,
abuse controls, auditable authentication events, and operating-system-protected secret
storage. Historical context: ADR-011 originally kept OAuth grants and bearer tokens in memory for
the single-owner deployment. Current v0.3.5 instead persists grant-family metadata and
token hashes in SQLite while never storing plaintext bearer/refresh credentials.

RFC 7009 defines a token revocation endpoint and requires a successful response for
unknown tokens so the endpoint does not become a token oracle.

## Decision

- Publish and implement an RFC 7009 `POST /revoke` endpoint.
- Authenticate revocation requests with the same registered-client methods supported by
  the token endpoint.
- Return success for unknown tokens and tokens owned by another client, without revealing
  whether a token exists.
- Treat access and refresh tokens issued from one authorization grant as one token family.
  Revoking either member invalidates the complete family immediately.
- Emit synchronous, structured authentication audit events through an injected sink.
  Events use a fixed schema and never contain bearer tokens, authorization codes,
  passphrases, client secrets, raw authorization headers, or request bodies.
- The production entry point writes audit events as JSON Lines to the process error stream,
  where the service manager owns access control, retention, and rotation.
- Keep pending authorization transactions and authorization codes bounded in memory.
- Persist grant-family metadata plus access/refresh token hashes in the OAuth SQLite
  store; never persist plaintext bearer/refresh credentials.
- Owner verifiers and optional confidential-client credentials remain in owner-only
  runtime files. Horizontally shared OAuth state still requires a separate decision.

## Consequences

- **Positive:** clients can disconnect cleanly, compromised grants can be invalidated
  without restart, and security events become machine-readable without exposing secrets.
- **Negative / costs:** revoking one family member also signs out all sessions derived from
  that grant; restart drops unfinished authorization transactions/codes but preserves
  durable clients and acknowledged grant/token-family state.
- **Risks and mitigations:** a token-scanning caller receives the same success response for
  unknown and foreign tokens. Client authentication and existing token-endpoint rate limits
  protect the revocation endpoint.

## Alternatives considered

Revoke only the submitted token. This leaves its sibling access or refresh credential
usable and was rejected in favor of complete grant invalidation.

Persist plaintext bearer tokens in a mode-0600 JSON file. This remains rejected. Current
durability stores cryptographic token hashes and grant metadata in the protected SQLite
store instead of plaintext bearer/refresh credentials.

Make audit logging best-effort inside each HTTP route. This risks inconsistent schemas and
missing service-level events, so an injected authority-level sink was selected.

## Verification

- Service tests prove client binding, foreign-token non-revocation, family-wide immediate
  revocation, and absence of tokens/passphrases in serialized audit events.
- HTTP tests prove discovery, RFC 7009 success semantics, and rejection of the revoked
  bearer token by the MCP endpoint.
- Abuse tests prove owner-authentication rate-limit events are audited.
- `npm run check` and a production build must pass.
