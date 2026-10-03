# SlncTrZ-MCP

**Owner-controlled access from Web AI to your Linux or Windows machine — files, commands, Agent Skills, tasks, and MCP servers through one gateway.**

SlncTrZ-MCP is a self-hosted gateway that lets AI clients work with your local projects.
You choose the filesystem Paths, Commands, and MCP providers they can use. The installed
Linux and Windows binaries include their runtime; Node.js and a source checkout are not required.

[Setup video](docs/SlncTrZ-MCP.mp4) · [User Guide](docs/USER_GUIDE.md) · [Releases](https://github.com/SlncTrZ/SlncTrZ-MCP/releases) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## Quick start

Choose an existing project or workspace directory as the initial Path. Replace the example
below with your directory; you can add more Paths later in the Owner Console.

### Linux x64

Download the installer, then create a User Install:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME/projects"
```

User Install does not create a service. Start the gateway with the `Start:` command printed
by setup. For default Linux locations:

```bash
SLNCTRZ_CONFIG_FILE="$HOME/.config/slnctrz-mcp/gateway.env" \
  "$HOME/.local/share/slnctrz-mcp/slnctrz-mcp-launcher"
```

Keep this process running while clients use the gateway.

### Windows x64 with Git Bash

Install **Git for Windows** and open **Git Bash**. Download the installer using the `curl`
command above, then select an existing Windows workspace:

```bash
sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path /c/Users/YourName/projects
```

Setup converts the Git Bash path to a native Windows path. Start the gateway using the
`Start:` path printed by setup. With default locations, run this in **PowerShell**:

```powershell
& "$env:LOCALAPPDATA\SlncTrZ-MCP\slnctrz-mcp.exe"
```

The native runtime needs neither Git Bash nor Node.js after installation.
Default locations are:

| Data    | Windows location             |
| ------- | ---------------------------- |
| Program | `%LOCALAPPDATA%\SlncTrZ-MCP` |
| State   | `%USERPROFILE%\.slnctrz-mcp` |
| Config  | `%APPDATA%\SlncTrZ-MCP`      |

### Linux system install

For a gateway managed by systemd, download the installer as above and run:

```bash
sudo sh /tmp/slnctrz-install.sh \
  --mode system \
  --port 3100 \
  --path /srv/slnctrz-workspace
```

The workspace must exist and be accessible to the invoking user. Setup enables and starts
the service. Privileged installation uses sudo; the gateway runs as the validated invoking
OS user. See [Deployment](docs/DEPLOYMENT.md) for requirements and custom locations.

## Open the Owner Console

Once the gateway is running, local defaults are:

| Surface         | URL                           |
| --------------- | ----------------------------- |
| Owner Console   | `http://127.0.0.1:3100/owner` |
| MCP endpoint    | `http://127.0.0.1:3100/mcp`   |
| Usage dashboard | `http://127.0.0.1:3100/usage` |

Setup prints the installed version, URLs, locations, and paths to the private credential files.
Read the Owner Passphrase from the indicated file to sign in; keep credential values private.

Review these controls before connecting a client:

| Control         | Purpose                                                                |
| --------------- | ---------------------------------------------------------------------- |
| **Autonomy**    | Choose Restricted or Autonomous runtime authority                      |
| **Paths**       | Select filesystem roots for Restricted file tools                      |
| **Commands**    | Select executables that Restricted `core.exec` may start               |
| **MCP Servers** | Add local or remote MCP providers                                      |
| **Connections** | Manage existing OAuth grants and their Full/Gateway-only tool profiles |

Start with **Restricted** and grant the project directories you need.
See the [User Guide](docs/USER_GUIDE.md) for first login and connection management.

## Connect an AI client

Local clients can use the loopback MCP endpoint. Cloud-hosted clients need a reachable
**public HTTPS endpoint**. Configure the installer with
`--public-url https://mcp.example.com/mcp` and route your reverse proxy or tunnel to the
gateway. The URL path must be exactly `/mcp`; follow [Deployment](docs/DEPLOYMENT.md)
for TLS, Host/Origin allowlists, and public exposure.

Add the MCP endpoint in your AI client and complete OAuth/Owner approval.

| Client         | Setup notes                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------- |
| ChatGPT / Grok | Dynamic registration with PKCE; normally no static Client Secret                             |
| Claude         | Configure the static Client ID/Secret from the private client file                           |
| Gemini Spark   | May require the documented browser redirect workaround; see [User Guide](docs/USER_GUIDE.md) |

These are setup notes; verified compatibility depends on evidence for the release and client.
After connection, the agent should call `core.ping` to check its profile and available tools.
Full connections then use `context.bootstrap` before ordinary work. Gateway-only hides coding/
context/task tools; its provider calls do not require a gateway context receipt.

Acknowledged OAuth grants/token families survive a normal restart. Pending authorization
transactions and authorization codes do not. Refresh tool discovery after an upgrade.

## Understand the authority boundary

- **Restricted:** built-in file tools stay inside configured canonical Paths; command starts
  use the owner-managed command catalog.
- **Autonomous:** tools use the filesystem and executable permissions of the gateway's OS account.
- General-purpose commands such as Bash, Python, PowerShell, Docker, or `sudo` can exercise
  that account's OS permissions. Restricted mode is a capability policy, not a full OS sandbox.
- `AGENTS.md`, skills, task text, and context receipts provide guidance and workflow state;
  they never grant additional authority.
- Owner configuration is separate from model-facing tools; there are no `owner.*` MCP tools.

Read [Security](SECURITY.md) and the [Threat Model](docs/THREAT_MODEL.md) before public deployment.

## What the gateway provides

| Capability             | Tools or interface                                                           |
| ---------------------- | ---------------------------------------------------------------------------- |
| Files and commands     | `core.read`, `core.search`, `core.write`, `core.edit`, `core.exec`           |
| Images                 | `media.read_image` when advertised by the running gateway                    |
| Coding context         | `context.bootstrap`, `context.close`, `skills.list`, `skills.read`           |
| Additional MCP servers | Owner-managed stdio/Streamable HTTP providers under `<provider>.<tool>`      |
| Usage                  | `/usage`: gateway traffic, estimated tokens, and avoided eager skill context |

Global instructions and skills live under `<stateRoot>/harness/`; project overlays are
optional. Skills load on demand so the agent does not receive the whole library on every
request. See [Harness](docs/HARNESS.md) for locations, limits, and context lifecycle.

Provider credentials remain in managed secret storage. Provider availability and tool
names come from the running catalog. See [MCP Servers](MCP_SERVERS.md) and
[Provider Standard](MCP_PROVIDER_STANDARD.md) to add your own.

The usage dashboard measures traffic visible to the gateway. Token and dollar figures are
estimates, not full webchat billing. Its separate metadata-only ledger does not store prompts,
file contents, command output, or credentials. Persistence failure does not block MCP work;
the dashboard exposes degraded/drop health.

## Managed tasks

Runner tasks execute commands asynchronously with the same authority as `core.exec`:
`task.start` → `task.get` / `task.wait` → `task.cancel`.

Coordination tasks share logical work between clients:
`task.create` → `task.claim` → `task.complete` / `task.fail`.

Task state is **in-memory only** and does not survive a gateway restart. Task text cannot
grant filesystem or command permissions. See [Model Guide](docs/MODEL_GUIDE.md) for the
agent-facing workflow.

## Operate and recover

Use the installed CLI for routine operations:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
slnctrz-mcp config show
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

If the CLI is not on PATH, use its installed launcher/executable path.
`doctor` is read-only; `repair` is bounded and preserves owner credentials and policy.
After the signing-enabled trust bootstrap, updates authenticate release manifests using
the embedded Ed25519 trust root and verify artifact size/SHA-256 before activation.

`slnctrz-mcp uninstall --yes` preserves customer state by default. The `--purge` option
also removes config, history, skills, and credentials.
See [Troubleshooting](docs/TROUBLESHOOTING.md) and [Backup and Restore](docs/BACKUP_RESTORE.md).

## Release and platform status

The v0.3.6 line includes safer OAuth failure handling, bounded provider recovery, durable
diagnostics, usage health, and publisher-authenticated update manifests.
Release status is determined by the published GitHub release and its acceptance evidence.

| Target                                  | Status                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| Linux x64 / Windows x64 standalone      | Public release targets; bundled runtime                         |
| Linux / Windows User Install            | Clean-install acceptance required by the release workflow       |
| Linux System Install                    | Implemented; support claims require clean systemd-host evidence |
| Windows System Install / macOS prebuilt | Not currently supported                                         |
| Source CI                               | Linux Node 22/24; Windows Node 24                               |

The project welcomes real-client testing and independent review. Automated gates do not
establish that every deployment or client has been independently verified.
See [Release Notes](docs/releases/v0.3.6.md), [Release Process](RELEASE.md), and
[Release Acceptance](docs/RELEASE_ACCEPTANCE.md).

## Documentation and contribution

| Need                                          | Guide                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Setup, clients, Owner Console                 | [User Guide](docs/USER_GUIDE.md)                                                                |
| Services, public HTTPS, runtime configuration | [Deployment](docs/DEPLOYMENT.md)                                                                |
| Agent instructions and skills                 | [Harness](docs/HARNESS.md), [Coding Agents](docs/CODING_AGENTS.md)                              |
| Security boundaries                           | [Security](SECURITY.md), [Threat Model](docs/THREAT_MODEL.md)                                   |
| Implementation and contribution               | [Architecture](ARCHITECTURE.md), [Engineering](ENGINEERING.md), [Contributing](CONTRIBUTING.md) |

Client test reports, clear bug reports, code review, skills, and provider integrations are
welcome. Open an issue with the version, platform, and reproducible behavior; omit credentials.

## Development

Requires Node `>=22.13.0 <25`.

```bash
npm ci
npm run check
npm run build
```

## License

Apache-2.0. See [LICENSE](LICENSE).
