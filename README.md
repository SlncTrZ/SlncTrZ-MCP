# SlncTrZ-MCP

**Let AI work with your real files, commands and MCP servers — from the chat or coding agent you already use.**

SlncTrZ-MCP is a self-hosted gateway for Linux and Windows. Connect once, choose what the
AI can access, and work with your projects through one MCP endpoint.

<a href="docs/SlncTrZ-MCP-intro.mp4"><img src="docs/SlncTrZ-MCP-intro.jpg" alt="Watch the 60-second introduction" width="260"></a>

[60-second introduction](docs/SlncTrZ-MCP-intro.mp4) · [Editable video source](docs/SlncTrZ-MCP-intro-source.zip) · [Setup walkthrough](docs/SlncTrZ-MCP.mp4) · [User Guide](docs/USER_GUIDE.md) · [Releases](https://github.com/SlncTrZ/SlncTrZ-MCP/releases)

## What can you do?

| You want to…                               | SlncTrZ-MCP provides                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Work with a local project from Web AI      | Read, search and edit files; run authorized commands             |
| Bring your working habits to the agent     | Global/project instructions and custom skills loaded when needed |
| Use several MCP servers from one client    | One endpoint and a consistent tool contract                      |
| Keep a coding agent's own harness          | Gateway-only: provider tools and Debate, with native OAuth       |
| Compare ideas or share work between agents | Native two-agent Debate and task coordination                    |
| Keep control of your machine               | Owner Console for Paths, Commands, MCP servers and connections   |

Use **Full** for the gateway's coding tools and harness. Use **Gateway-only** when OpenCode,
Pi, Codex or Claude Code already handles local coding and you only need shared MCP providers.
Choose Gateway-only on the first OAuth approval: it stays connected until revoked, refreshes
automatically, and cannot be promoted to Full. See [Connect coding agents](docs/GATEWAY_ONLY.md).

## Why I built it

I use GPT in web chat to work with files on my machine, including with a Free account.
With Plus and above, I use Chat plus SlncTrZ-MCP as a working session; on my account this
does not reduce the Work/Codex usage percentage. That is my experience with the platform's
normal Chat/plugin flow. Chat model limits and availability still follow the account plan.

The gateway also lets my agents use the same MCP providers, discuss a problem through
Debate, and delegate suitable work to smaller models. You choose the models and clients;
SlncTrZ connects them to your tools.

## Quick start

Download the installer in a Linux shell or **Git Bash on Windows**:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "$HOME/projects"
```

Choose an existing project directory. On Windows, use a Git Bash path such as
`/c/Users/YourName/projects`. Start the gateway with the `Start:` command printed by setup.

1. Open the **Owner Console** at `http://127.0.0.1:3100/` and sign in.
2. Review **Paths**, **Commands** and **MCP Servers**.
3. Add `http://127.0.0.1:3100/mcp` to your client and complete OAuth.

Cloud clients need a reachable HTTPS endpoint. The installed binaries include their runtime;
Node.js is only needed for source development.

[Installation and Windows launch](docs/USER_GUIDE.md#1-installation--endpoints) · [Public HTTPS / system service](docs/DEPLOYMENT.md)

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
| Planned upgrades and release evidence | [Plan](PLAN.md) · [Release Notes](docs/releases/v0.3.7.md)        |
| Browse all documentation              | [Documentation index](docs/README.md)                             |

Linux x64 and Windows x64 are the standalone release targets. The new Gateway-only consent
flow is currently an unreleased source change; check the [changelog](CHANGELOG.md) and
published release before expecting it in an installed binary.

## Development

Requires Node `>=22.13.0 <25`.

```bash
npm ci
npm run check
npm run build
```

Apache-2.0. See [LICENSE](LICENSE).
