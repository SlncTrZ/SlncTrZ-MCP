# SlncTrZ-MCP

**Let AI work with your real files, commands and MCP servers — from the chat or coding agent you already use.**

SlncTrZ-MCP is a self-hosted gateway for Linux and Windows. Connect once, choose what the
AI can access, and work with your projects through one MCP endpoint.

<p align="center">
  <img src="docs/SlncTrZ-MCP-intro.svg" alt="SlncTrZ-MCP gateway, built-in harness and default skills" width="100%">
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a> · <a href="https://github.com/SlncTrZ/SlncTrZ-MCP/releases">Releases</a>
</p>

## What can you do?

| You want to…                               | SlncTrZ-MCP provides                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Work with a local project from Web AI      | Read, search and edit files; run authorized commands                                 |
| Bring your working habits to the agent     | Built-in working guidance, global/project instructions and skills loaded when needed |
| Use several MCP servers from one client    | One endpoint and a consistent tool contract                                          |
| Keep a coding agent's own harness          | Gateway-only: provider tools and Debate, with native OAuth                           |
| Compare ideas or share work between agents | Native two-agent Debate and task coordination                                        |
| Keep control of your machine               | Owner Console for Paths, Commands, MCP servers and connections                       |

Use **Full** for the gateway's coding tools and harness. Use **Gateway-only** when OpenCode,
Pi, Codex or Claude Code already handles local coding and you only need shared MCP providers.
Choose Gateway-only on the first OAuth approval: the grant lasts until revoked and cannot
be promoted to Full. Compatible clients handle rotating refresh tokens. See [Connect coding agents](docs/GATEWAY_ONLY.md).

The **built-in harness** supplies product working guidance to Full connections. Fresh installs
also seed the **code-review** and **debug-and-test** skills, preserving existing owner files.
Instructions and skills load progressively through `context.bootstrap` and `skills.read`;
additional repository skills are discovered for an authorized project or installed explicitly.
See [Harness & Skills](docs/HARNESS.md) and [bundled defaults](skills/README.md).
Gateway-only clients keep their own harness.

## Why use a gateway?

Keep your projects and provider configuration on your machine while choosing the AI client
that works for each task. A Web AI can use the Full profile to work on an authorized project;
a coding agent can use Gateway-only to share providers without replacing its own tools.

You control access in one Owner Console. Add providers or skills when needed, and back up
your configuration and state when moving or updating the gateway. Your AI platform's plans,
usage limits and billing still apply; the gateway does not increase those allowances.

## Quick start

**Linux x64:** terminal (User or System service). **Windows x64:** Git Bash for User Install.

Download the official installer:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh
```

### 1. Install on Linux

- **Linux User Install (`--mode user`, default):**

  ```bash
  sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "$HOME/projects"
  ```

  Runs as a foreground process via the printed launcher. To run as a background service without root privileges, set up `systemd --user`:

  ```bash
  mkdir -p ~/.config/systemd/user
  # Point ExecStart to ~/.local/bin/slnctrz-mcp and enable:
  systemctl --user daemon-reload && systemctl --user enable --now slnctrz-mcp.service
  ```

- **Linux System Service (`--mode system`, systemd):**
  Requires `sudo`. Automatically provisions and registers `/etc/systemd/system/slnctrz-mcp.service`:

  ```bash
  sudo sh /tmp/slnctrz-install.sh --mode system --port 3100 --path /srv/projects
  sudo systemctl status slnctrz-mcp
  sudo systemctl restart slnctrz-mcp
  ```

  _Security Note:_ The service runs as the invoking non-root user (`SUDO_USER`), never as root.

### 2. Install on Windows

Run Git Bash (User Install, no Administrator escalation needed):

```bash
sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "/c/Users/YourName/projects"
```

Run the **Start:** command printed by setup (runnable from PowerShell or cmd.exe). Windows System Install/service is unsupported.

---

### 3. Connect AI Clients

1. Open the **Owner Console** at `http://127.0.0.1:3100/`. Read the Owner passphrase privately
   from the file identified by setup and enter it only in the Console/consent page.
2. Review Paths, Commands and MCP Servers.
3. Choose your client connection method:
   - **Method A — Host Tokens (Headless / Coding Agents):** For OpenCode, Pi, Codex, or background scripts where browser OAuth is undesirable. Issue a token in the Owner Console or via CLI:
     ```bash
     slnctrz-mcp owner host-token issue --label "OpenCode"
     ```
     Configure your client with `Authorization: Bearer hst_...` to `http://127.0.0.1:3100/mcp`. Host tokens are hard-coded to **Gateway-only** and automatically deleted after 15 days of inactivity (ADR-030).
   - **Method B — Native OAuth 2.0 PKCE (Web AI / Claude):** Connect client to `http://127.0.0.1:3100/mcp`, complete browser consent, and select **Full** (with coding tools) or **Gateway-only** (providers only).
4. Ask the client to call `core.ping`; check the gateway identity, profile and available tools.

For a cloud AI, use a reachable HTTPS endpoint and the
[AI Web connection steps](docs/USER_GUIDE.md#connect-an-ai-web-client).
Installed binaries include their runtime; Node.js is only needed for source development.

[Linux and Windows steps](docs/USER_GUIDE.md#1-installation--endpoints) ·
[OpenCode / Pi / Codex / Claude Code](docs/GATEWAY_ONLY.md) ·
[HTTPS / Linux system service](docs/DEPLOYMENT.md)

## Know the boundaries

- **Restricted** uses configured Paths and Commands. **Autonomous** uses the gateway OS account's permissions.
- An authorized shell or interpreter can exercise that account's permissions; Restricted is a capability policy, not a full OS sandbox.
- Gateway-only limits gateway tools. It does not sandbox provider tools or the coding agent's own tools.
- OAuth connections and Debate history persist. Task state and context receipts reset on restart.
- The usage dashboard estimates gateway traffic; it does not measure your platform allowance or bill.

See [Security](SECURITY.md) and [Backup and Restore](docs/BACKUP_RESTORE.md).

## Documentation

| Need                                  | Start here                                                        |
| ------------------------------------- | ----------------------------------------------------------------- |
| Install, connect and use the gateway  | [User Guide](docs/USER_GUIDE.md)                                  |
| Native OAuth for coding agents        | [Gateway-only](docs/GATEWAY_ONLY.md)                              |
| Add MCP providers or custom skills    | [MCP Servers](MCP_SERVERS.md) · [Harness](docs/HARNESS.md)        |
| Diagnose or update an installation    | [Troubleshooting](docs/TROUBLESHOOTING.md)                        |
| Contribute or inspect the design      | [Contributing](CONTRIBUTING.md) · [Architecture](ARCHITECTURE.md) |
| Planned upgrades and release evidence | [Plan](PLAN.md) · [Release Notes](docs/releases/v0.4.7.md)        |
| Browse all documentation              | [Documentation index](docs/README.md)                             |

Linux x64 and Windows x64 are the standalone release targets. This tree prepares
[v0.4.6](docs/releases/v0.4.7.md); publication becomes stable only after the signed
release workflow passes its public installation and browser gates. Check the
[latest published release](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest)
for current availability. Source, published release and running process are separate
identities; see [Project Status](docs/PROJECT_STATUS.md).

## Development

Requires Node `>=22.13.0 <25`.

```bash
npm ci
npm run check
npm run build
```

Apache-2.0. See [LICENSE](LICENSE).
