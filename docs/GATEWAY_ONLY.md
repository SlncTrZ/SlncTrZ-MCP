# Gateway-Only Profile

Use Gateway-only when your coding agent already manages local files and commands, and you
want shared MCP providers and Debate. Use Full when you want the gateway's coding tools and
harness too. This profile/consent behavior is included in published v0.4.2.

## 1. Profile Isolation

- Full advertises gateway coding/file/media/context/skills/task tools subject to authority.
- Gateway-only retains core.ping, connection.restrict, Debate and enabled provider tools.
  Provider tools and Debate are directly usable on this profile; coding/context/skills/task
  tools are hidden and no context receipt is ever required.
- First Gateway-only consent sets a ceiling: refresh and Owner controls cannot promote it to
  Full. Make a separate fresh Full connection if you need gateway coding tools.
- New Gateway-only grants survive restart/offline periods until revoked. Access tokens expire;
  refresh tokens rotate and are single-use.
- Migrated schema-v1/v2 grants retain their original finite lifetimes.
- This profile does not sandbox provider tools or the coding client's own tools.

## 2. Connect your coding agent

Replace `https://mcp.example.com/mcp` with your gateway endpoint. A client on the gateway
machine can use `http://127.0.0.1:3100/mcp`; a remote/cloud client needs an endpoint it can
reach. Start the gateway first.

These recipes configure the connection only; the profile is selected at the browser consent
step. Choose Gateway-only for enabled providers and Debate, or Full for the gateway coding
tools and harness. The recipes are identical either way.

Terminology: the installer bootstrap (`install.sh`) installs the gateway software. It is not
`context.bootstrap`, the Full-profile MCP tool that returns a harness context receipt.
Gateway-only connections never call `context.bootstrap` or supply `slnctrzContext`.

### OpenCode 1.x

Add this entry to an existing `opencode.json`/JSONC project config, merging it with your
other settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "slnctrz": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

```bash
opencode mcp auth slnctrz
opencode mcp list
```

Complete browser consent and select Gateway-only. OpenCode 1.18.18's installed help confirms
the auth/list/logout commands; the remote entry follows official 1.x documentation.
Do not apply this configuration shape to OpenCode 2.x without checking its own guide.
[OpenCode MCP](https://docs.opencode.ai/docs/mcp-servers/) ·
[Config locations](https://docs.opencode.ai/docs/config/)

### Pi 1.1.0 — Earendil Works distribution

For `@earendil-works/pi-coding-agent` 1.1.0, the installed MCP help confirms:

```bash
pi mcp add slnctrz --url https://mcp.example.com/mcp
pi mcp login slnctrz
pi mcp list
```

This writes the global `~/.pi/agent/mcp.json`; `-l` selects project `.pi/mcp.json` where
trusted. Consent is in the browser. This distribution has built-in MCP support; no bridge
plugin was required to obtain the help. A different Pi implementation/version may differ.
[Pi upstream](https://github.com/earendil-works/pi)

### Codex CLI — documentation recipe

```bash
codex mcp add slnctrz --url https://mcp.example.com/mcp
codex mcp login slnctrz
codex mcp list
```

Codex stores server settings in `~/.codex/config.toml`; trusted projects may use
`.codex/config.toml`. Use native OAuth and inspect `/mcp` in the TUI.
[Official MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### Claude Code — documentation recipe

```bash
claude mcp add --transport http slnctrz https://mcp.example.com/mcp
claude mcp list
```

Run `/mcp` inside Claude Code and complete OAuth. Default local entries are stored in
`~/.claude.json` and apply to the current project; shared project entries use `.mcp.json`.
Check your installed version's help before changing scope.
[Official MCP guide](https://code.claude.com/docs/en/mcp)

## 3. Verification and reconnect

After consent, ask the client to call `core.ping`. Check `surfaceProfile`, then refresh tool
discovery. Gateway-only should show enabled providers and Debate without core file/exec,
context/skills or task tools. No provider is guaranteed available just because it was added.

The [client evidence matrix](CODING_AGENTS.md#client-evidence-matrix) separates installed
help from end-to-end tests. The recipes above have not been verified for consent, discovery,
refresh/reconnect and revocation against an identified SlncTrZ installed artifact.

If an approved grant is revoked, make a fresh consent. Removing a client's local credentials
is not the same as revoking the grant in Owner Connections. Serialize refresh requests;
reusing a single-use token can fail. Follow [Troubleshooting](TROUBLESHOOTING.md) before
treating every network or server error as an auth problem.

The v0.4.3 exec-environment and Owner session/navigation improvements do not change this
profile contract. Gateway-only provider calls no longer require context.bootstrap or a receipt;
Full guards remain enforced. The unreleased v0.4.5 cancellation patch is tracked separately in
[Project Status](PROJECT_STATUS.md) and does not change OAuth grants or ceilings.
