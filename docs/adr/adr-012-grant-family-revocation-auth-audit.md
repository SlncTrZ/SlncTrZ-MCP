# ADR-012: Grant-family token revocation and redacted authentication audit

> Status: Accepted  
> Date: 2026-08-26  
> Owners: SlncTrZ

## Context

PLAN Phase 2 requires an explicit token revocation lifecycle, immediate revocation,
abuse controls, auditable authentication events, and operating-system-protected secret
storage. ADR-011 deliberately keeps OAuth grants and bearer tokens in memory for the
single-owner deployment; persisting bearer credentials would expand the at-rest attack
surface and introduce key-management requirements that Phase 2 does not otherwise need.

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
- Continue to keep pending grants, codes, access tokens, and refresh tokens in memory under
  ADR-011. Owner verifiers and optional confidential-client credentials remain in
  owner-only runtime files. Persistent or horizontally shared OAuth state requires a
  separate decision with explicit encryption and key management.

## Consequences

- **Positive:** clients can disconnect cleanly, compromised grants can be invalidated
  without restart, and security events become machine-readable without exposing secrets.
- **Negative / costs:** revoking one family member also signs out all sessions derived from
  that grant; restart still invalidates all OAuth state.
- **Risks and mitigations:** a token-scanning caller receives the same success response for
  unknown and foreign tokens. Client authentication and existing token-endpoint rate limits
  protect the revocation endpoint.

## Alternatives considered

Revoke only the submitted token. This leaves its sibling access or refresh credential
usable and was rejected in favor of complete grant invalidation.

Persist bearer tokens in a mode-0600 JSON file. This would survive restart but creates a
new credential-at-rest target without an encryption-key lifecycle, so it is deferred.

Make audit logging best-effort inside each HTTP route. This risks inconsistent schemas and
missing service-level events, so an injected authority-level sink was selected.

## Verification

- Service tests prove client binding, foreign-token non-revocation, family-wide immediate
  revocation, and absence of tokens/passphrases in serialized audit events.
- HTTP tests prove discovery, RFC 7009 success semantics, and rejection of the revoked
  bearer token by the MCP endpoint.
- Abuse tests prove owner-authentication rate-limit events are audited.
- `npm run check` and a production build must pass.
