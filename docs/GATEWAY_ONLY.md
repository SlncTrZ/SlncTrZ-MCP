# Gateway-Only Profile

Use this when a coding client's own tools handle local work and the gateway supplies shared
providers and Debate. This consent/lifetime behavior is included in unreleased v0.4.0 source;
installed availability follows the published release status.

## 1. Profile Isolation

- Full advertises gateway coding/file/media/context/skills/task tools subject to authority.
- Gateway-only retains core.ping, connection.restrict, Debate and enabled provider tools.
- The first Gateway-only consent sets an immutable ceiling: refresh and Owner controls cannot
  promote it to Full. A fresh Full consent is required for a separate Full connection.
- New Gateway-only grants survive restart/offline periods until revoked. Access tokens expire;
  refresh tokens are single-use and rotate after every successful refresh.
- Existing schema-v1/v2 grants retain their original finite lifetimes after v3 migration.
- Provider tools and the client's own tools retain their own authority; this profile is not
  an OS sandbox or a guarantee of continuous network/provider availability.

## 2. CLI Login Examples

Configure the MCP endpoint in the client first, then use the login/auth flow its installed
version supports. Select Gateway-only on the gateway's first consent page.

```bash
pi mcp login slnctrz
codex mcp login slnctrz
opencode mcp auth slnctrz
```

These are documented integration examples, not evidence that every version of each client
is release-verified. Use native MCP/OAuth when available; read client help rather than
assuming a separate bridge is necessary.

## 3. Reconnect & Revocation

Inspect core.ping's surfaceProfile and refresh tool discovery after profile/config changes.
A revoked connection cannot refresh; reconnect through fresh consent. Serialize refresh
operations so a client does not reuse a single-use token concurrently.

See [Coding Agents](CODING_AGENTS.md), [Backup](BACKUP_RESTORE.md) and
[Release Acceptance](RELEASE_ACCEPTANCE.md).
