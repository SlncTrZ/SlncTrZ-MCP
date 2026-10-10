# Coding Agents Integration

Choose the profile before integrating a coding client. [Gateway-only](GATEWAY_ONLY.md)
keeps the client's own filesystem/harness; Full adds gateway coding/context/task tools.

## 1. Connection & Protocol

Start with the copyable recipes in [Gateway-only](GATEWAY_ONLY.md) or the
[AI Web steps](USER_GUIDE.md#connect-an-ai-web-client). Choose Full for gateway coding tools
and harness; Gateway-only keeps the client's own harness. Approve only the paths, commands
and providers needed for the work.

Connect to the configured HTTP /mcp endpoint and complete OAuth PKCE. Cloud clients need
reachable HTTPS. Each client's MCP configuration and login syntax are client-version facts;
the example flows do not establish release-specific compatibility.

The profile is selected at the gateway's browser consent step: Full adds gateway
coding/context/skills/task tools and the harness; Gateway-only keeps the client's own harness
and exposes only enabled providers and Debate. context.bootstrap, skills.* and slnctrzContext
are Full-only and are never required on Gateway-only connections. context.bootstrap is the
Full-profile MCP tool, distinct from the installer bootstrap (`install.sh`) that installs the
gateway software.

## 2. Session Context & Receipts

For Full ordinary coding calls, including reads, search, mutations and task tools:

1. Call context.bootstrap and read its instructions, diagnostics and catalog.
2. Keep the returned contextToken private; pass it as `slnctrzContext`.
3. Alternatively, put the same value in MCP request `_meta["org.slnctrz/contextToken"]`.
   Supplying conflicting argument/metadata receipts is rejected.
4. Bootstrap again on context_required/context_stale; those rejected operations were not executed.
5. Release with context.close after work.

Receipts do not widen capability authority. They expire after four hours and reset on gateway
restart. core.ping can inspect identity/profile without a context; it exposes modelGuide,
agentHarness and managedTasks in structuredContent. Bootstrap delivers sourced instructions
and catalog metadata, not all skill bodies. Gateway-only providers and Debate need no gateway
receipt and never call context.bootstrap or supply slnctrzContext.

## 3. Skills Loading

Browse skills.list, activate a selected skill with skills.read, then read its referenced
resources on demand. Discovery uses the owner global harness and an optional authorized
projectRoot; it does not implicitly discover a coding client's local project.

Fresh installed harnesses contain code-review/debug-and-test only. Additional repository
skills require project discovery or explicit owner installation. See [Harness](HARNESS.md).

## Client evidence matrix

Checked 2026-10-09. **Help checked** means executable/version and command syntax were read
locally. **Docs only** means a primary vendor guide was checked. Neither means end-to-end
compatibility. The intended profile below is not a record of consent actually granted.

| Client / implementation              | Version evidence                                   | OS / transport / intended profile                              | Config location                                                          | Setup and auth                                               | Evidence level                                       |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| OpenCode `opencode-ai`               | 1.18.18 locally                                    | Windows / Streamable HTTP / Full or Gateway-only               | Project `opencode.json`/JSONC; global `~/.config/opencode/opencode.json` | Remote entry; `opencode mcp auth slnctrz`                    | Help checked; 1.x config docs checked                |
| Pi `@earendil-works/pi-coding-agent` | 1.1.0 locally; installer package pins that version | Windows / Streamable HTTP / Full or Gateway-only               | `~/.pi/agent/mcp.json`; trusted project `.pi/mcp.json`                   | `pi mcp add slnctrz --url ...`; `pi mcp login slnctrz`       | MCP help checked; built-in implementation identified |
| Codex CLI                            | Not installed on the inspected hosts               | OS acceptance pending / Streamable HTTP / Full or Gateway-only | `~/.codex/config.toml`; trusted project `.codex/config.toml`             | `codex mcp add slnctrz --url ...`; `codex mcp login slnctrz` | Docs only                                            |
| Claude Code                          | Not installed on the inspected hosts               | OS acceptance pending / HTTP / Full or Gateway-only            | `~/.claude.json` local/user scope; `.mcp.json` project scope             | `claude mcp add --transport http ...`; interactive `/mcp`    | Docs only                                            |
| ChatGPT Web                          | Web version/account not identified for acceptance  | Cloud / public HTTPS Streamable HTTP / Full or Gateway-only    | Account/workspace plugin configuration                                   | Custom MCP server → OAuth → install/select plugin            | Docs only                                            |
| Claude Web                           | Web version/account not identified for acceptance  | Cloud / public HTTPS Streamable HTTP / Full or Gateway-only    | Account/organization connector configuration                             | Custom Web connector → OAuth/DCR → enable in chat            | Docs only                                            |

No listed client has a recorded WP-01 end-to-end consent outcome, `core.ping`/tool discovery,
refresh, reconnect or revoke result. Linux clients were not installed on the inspected host.
The local help check did not alter client config or run login. Its historical source
baseline was package 0.4.2 at `021c45c00397918791d0c26b70357b8070c514b6`; no listed
client was tested against an installed server artifact in that check. Foundational docs
are now committed/pushed as `0cb09db`. [Project Status](PROJECT_STATUS.md)
records current source CI separately from published v0.4.4, pending v0.4.5 and the running process.
The review branch is now merged into main together with PR #6/#7. Source integration,
commit/push and main CI do not upgrade these client evidence levels.

For an acceptance record, identify the client version/plugin, OS, exact server
version/build/artifact hash, config scope and date. Record consent/profile, discovery,
a read-only `core.ping`, refresh/reconnect and server-side revocation. Keep credential values,
OAuth URLs containing codes/state, and private deployment addresses out of the record.
Do not rerun mutations merely to diagnose a connection.

Use client logout only when intending to delete its stored OAuth credentials:
`opencode mcp logout slnctrz`, `pi mcp logout slnctrz` or `codex mcp logout slnctrz`.
Use Owner Connections to revoke gateway access; verify discovery again after reconnect.
