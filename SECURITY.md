# Security Policy

## Supported versions

Security fixes target the **latest release** and the `master` branch. Older releases
are supported on a case-by-case basis.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.** Report privately via one
of the channels used for the project. If no private channel is yet configured, report
the issue as a private draft and ask for a secure handoff.

When reporting, include:

- The affected component/version.
- A minimal reproduction (ideally a failing test).
- The impact and any proposed mitigation.
- Whether the issue is already publicly known.

You will receive an acknowledgement. We ask that you allow a reasonable window before
public disclosure.

## Security invariants (ARCHITECTURE §11)

The following must never be violated. If a change weakens any of them, it is blocking.

1. No request executes without authenticated identity and a policy decision.
2. No workspace is allowed implicitly.
3. Secret deny rules override allow rules.
4. Writable paths do not imply executable trust.
5. Extension credentials are least-privilege and provider-scoped.
6. Untrusted extensions do not execute in the core process.
7. Client sessions and capability negotiation are not shared across security contexts.
8. Tool names cannot collide silently.
9. Configuration activation is atomic.
10. Logs and errors never disclose credentials.
11. Instruction files cannot grant capabilities.
12. Public ingress cannot reach the local control plane.

## Secrets

Never commit secrets, tokens, passphrases, or private keys. Secrets are referenced by
opaque identifier (e.g. `os-keychain://slnctrz/github-main`) — see ARCHITECTURE §7.
`.env*`, key material, and credential stores are excluded from the repository.
