# SlncTrZ-MCP

SlncTrZ-MCP is a local-first, self-hosted MCP gateway that lets AI clients use selected files, commands, and other MCP servers through one owner-controlled endpoint.

The owner decides how much authority the gateway has:

- **Restricted** — built-in file tools stay inside configured Paths; `core.exec` can start only approved Commands.
- **Autonomous** — core tools may use the filesystem and command authority of the OS account running SlncTrZ-MCP.

Restricted mode is intentionally conservative, but it is **not an OS sandbox**. If you allow Bash, Python, Node, PowerShell, Docker, or another general-purpose interpreter/admin tool, that process can use the OS permissions of the gateway account.

## One gateway for every AI client

- **Windows & Linux** — install on a workstation or a self-hosted server with one command.
- **Works with ChatGPT / Claude / Grok — even on a free account.** A single owner-controlled endpoint they can all use.
- **Use ChatGPT to work with your files** — connect a project folder and let it read, search, and shape your work.
- **Built for coding agents** — wire it into Claude Code, Cursor, Zed, Codex, and other agent workflows.
- **You control the authority** — Restricted or Autonomous; you decide what the AI can touch.

[▶ Watch the introduction & setup video](docs/SlncTrZ-MCP.mp4)

> A quick walkthrough — install, connect your AI client, add a Path, add an MCP server. If the inline player does not load, open the raw file directly or save it locally.

## What it is for

SlncTrZ-MCP is designed for:

- a personal workstation where you want one controlled gateway for AI tools;
- a development machine where file and command access should be explicit;
- a self-hosted Linux server;
- connecting one AI client to multiple MCP providers through a stable gateway namespace.

The gateway is local-first. Public exposure is optional for local use. A publicly reachable HTTPS MCP URL is needed only when the client itself runs in the cloud and must reach your gateway over the Internet.

## Current support

### Source/developer support

| Environment           | Status           |
| --------------------- | ---------------- |
| Linux + Node 22       | CI target        |
| Linux + Node 24       | CI target        |
| Windows + Node 24     | Native CI target |
| Node version contract | `>=22.13.0 <25`  |

### Prebuilt end-user support

| Target                     | Status                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Linux x64 standalone SEA   | Public release target                                                                     |
| Linux x64 User Install     | Release-gated clean-host acceptance                                                       |
| Linux x64 System Install   | Implemented; clean systemd-host release evidence required before a verified support claim |
| Windows x64 standalone SEA | Public release target in the current 0.2.x line                                           |
| Windows x64 User Install   | Git Bash bootstrap + native installed runtime; release-gated clean-host acceptance        |
| Windows System Install     | Not yet supported                                                                         |
| macOS standalone installer | Not yet a public prebuilt support target                                                  |

A platform is not advertised as end-user supported merely because the source compiles there.

## Quick install — Linux x64

For a published release, download the bootstrap and run it locally:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME"
```

The bootstrap downloads the release binary and `SHA256SUMS`, verifies the binary, then runs the product `setup` flow. The standalone runtime does **not** require a repository checkout, `node_modules`, or a system Node.js installation.

## Quick install — Windows x64 with Git Bash

Install **Git for Windows**, open **Git Bash**, then run:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME"
```

Git Bash is required only for the bootstrap. The installed gateway is a native `slnctrz-mcp.exe` and does **not** require Git Bash, Node.js, npm, or a repository checkout after installation.

Default Windows User Install locations:

```text
Program: %LOCALAPPDATA%\SlncTrZ-MCP
State:   %USERPROFILE%\.slnctrz-mcp
Config:  %APPDATA%\SlncTrZ-MCP
```

The Git Bash bootstrap converts POSIX-style paths such as `/c/Users/Alice/work` to native Windows paths before invoking the native executable. Windows **System Install/service mode is not yet supported**; use `--mode user`.

For a server-style Linux system install:

```bash
sudo sh /tmp/slnctrz-install.sh \
  --mode system \
  --port 3100 \
  --path /srv/slnctrz-workspace
```

System mode creates/uses the dedicated `slnctrz` runtime account, verifies that account can read the initial Path, installs the systemd service, starts it, and health-checks it. Use a Path the service account is intentionally allowed to access.

### Local vs public setup

Local mode is the default and does not need a domain:

```text
MCP endpoint:  http://127.0.0.1:3100/mcp
Owner Console: http://127.0.0.1:3100/owner
```

For a cloud client, configure the public HTTPS MCP URL:

```bash
sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME" \
  --public-url https://mcp.example.com/mcp
```

The public URL must be HTTPS and its path must be exactly `/mcp`. Reverse proxy/TLS setup is documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## What setup gives you

A successful first setup prints:

- installed version;
- install mode and runtime account;
- Restricted/Autonomous authority;
- install, state, and config locations;
- MCP endpoint;
- Owner Console URL;
- **Owner Passphrase** on first creation only;
- permanent Owner Passphrase recovery-file path.

Ordinary reinstall preserves the existing installation identity, state, policy, provider configuration, and Owner Passphrase.

Keep the Owner Passphrase private. It controls the Owner Console and the authenticated loopback control plane.

## First run

1. Open the printed Owner Console URL.
2. Sign in with the Owner Passphrase.
3. Confirm **Autonomy**. Restricted is the recommended default.
4. Review **Paths**.
5. Review **Commands**. Fresh Restricted setup starts with an empty command allowlist.
6. Add MCP Servers only when you need them.

The main owner-facing concepts are:

| Concept     | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| Autonomy    | Restricted or Autonomous authority mode                         |
| Paths       | Filesystem roots available to built-in tools in Restricted mode |
| Commands    | Executables `core.exec` may start in Restricted mode            |
| MCP Servers | External/local MCP providers aggregated by the gateway          |

For MCP provider configuration, see [MCP_SERVERS.md](MCP_SERVERS.md) and [MCP_PROVIDER_STANDARD.md](MCP_PROVIDER_STANDARD.md).

## Connect an AI client

The client connects to:

```text
<your MCP endpoint>
```

SlncTrZ-MCP provides MCP/OAuth handling and owner approval. After connection, the client should call `core.ping` first to see active authority, Paths, Commands, provider readiness, and model guidance.

Cloud-hosted clients generally require a publicly reachable HTTPS endpoint. Local clients can use the loopback endpoint directly.

Dynamic client registrations persist, but pending authorization state, authorization codes, access tokens, and refresh tokens are intentionally in memory. A gateway restart can therefore require the AI client to reconnect or reauthorize even when the client registration itself still exists.

Client-specific release claims are evidence-based: ChatGPT and Claude are not marked as verified for a release until the published artifact has passed the real-client acceptance flow documented in [RELEASE.md](RELEASE.md).

## Core tools

The gateway exposes a small fixed core surface:

| Tool          | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `core.ping`   | Runtime status, authority, Paths, Commands, provider state, model guidance |
| `core.read`   | Read UTF-8 files                                                           |
| `core.search` | Search files/directories                                                   |
| `core.write`  | Atomic file write; `dryRun:true` previews                                  |
| `core.edit`   | Exact-match edit; `dryRun:true` previews                                   |
| `core.exec`   | Run approved/native commands under bounded execution rules                 |

## Managed tasks

When Task Runtime is enabled, the gateway also exposes a bounded `task.*` surface with two distinct roles.

**Runner tasks** execute one command asynchronously:

```text
task.start -> task.get / task.wait -> task.cancel
```

`task.start` uses the same execution authority as `core.exec`; it does not create a second command-policy path. Runner tasks are creator-private and workspace-bound. Cancelling a `task.wait` request does not cancel the underlying process; use `task.cancel` explicitly.

**Coordination tasks** share logical work between authenticated clients in the same workspace:

```text
task.create -> task.list / task.get -> task.claim
            -> task.release | task.complete | task.fail
```

Coordination task text is context, not authority. Exactly one client may hold a claim at a time, only the claimant may release/complete/fail, and the creator may cancel the task. Current task state is intentionally **in-memory only** and does not survive a gateway restart.

MCP provider tools are exposed under the canonical namespace:

```text
<provider>.<tool>
```

## Operate the installed product

For a step-by-step walkthrough of adding workspace Paths and MCP servers from the Owner Console (plus the virtual Provider-ID best practice), see [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

### Status

```bash
slnctrz-mcp status
slnctrz-mcp status --json
```

Status compares the active verified installed release with the authenticated running gateway identity when available.

### Doctor

```bash
slnctrz-mcp doctor
slnctrz-mcp doctor --json
```

`doctor` is read-only. It checks installation integrity, state/config validity, Paths, owner-secret permissions, provider state, disk signal, health reachability, and installed-vs-running version identity.

### Configuration

```bash
slnctrz-mcp config show
slnctrz-mcp config set port 3200
slnctrz-mcp config set owner-console true
slnctrz-mcp config set public-url https://mcp.example.com/mcp
slnctrz-mcp config set public-url local
```

Validated config changes report when a restart is required.

### OAuth client credentials

This gateway is an OAuth-protected MCP server: MCP clients authenticate against it before calling tools. Every install auto-provisions a **static confidential client** so a fixed `client_id`/`client_secret` is always available.

On a fresh setup (first run only) the installer prints and stores:

- **Client ID** — default `slnctrz-mcp`;
- **Client Secret** — a random, generated value (returned on first creation only);
- **Owner Passphrase** — the Owner Console / control-plane secret.

These live in mode-0600 files under `<configRoot>`:

```text
<configRoot>/gateway.env   SLNCTRZ_CLIENT_* are NOT stored here
<configRoot>/client.env    SLNCTRZ_CLIENT_ID, SLNCTRZ_CLIENT_SECRET, SLNCTRZ_CLIENT_NAME, SLNCTRZ_CLIENT_REDIRECT_URIS
<stateRoot>/secrets/owner-passphrase
```

Linux system-install defaults: `/etc/slnctrz-mcp/client.env`, `/etc/slnctrz-mcp/gateway.env`, `/var/lib/slnctrz-mcp/secrets/owner-passphrase`.

**Read them after install:**

```bash
slnctrz-mcp config show            # prints staticClientId + staticClientFile
cat <configRoot>/client.env        # operator-editable SLNCTRZ_CLIENT_SECRET
cat <stateRoot>/secrets/owner-passphrase   # owner passphrase
```

The Client Secret is not echoed by `config show` (it is a secret); read it from the `client.env` file directly.

**Customise / rotate:** edit `<configRoot>/client.env` (change `SLNCTRZ_CLIENT_ID`, `SLNCTRZ_CLIENT_SECRET`, optionally `SLNCTRZ_CLIENT_REDIRECT_URIS`), then restart the gateway. A reinstall or `update` **preserves** an existing `client.env` — it never silently overwrites your edits.

**Which clients need what:**

- **ChatGPT / Grok** (dynamic-registration MCP clients) — **no `SLNCTRZ_CLIENT_ID` / `SLNCTRZ_CLIENT_SECRET` needed.** They register dynamically (`POST /register`), receive a public `client_id`, and authenticate with **PKCE** only. Point them at the MCP URL and approve the OAuth consent.
- **Claude** — **requires `SLNCTRZ_CLIENT_ID` / `SLNCTRZ_CLIENT_SECRET`.** Configure the connector with `oauth` auth (method `client_secret_basic` / `client_secret_post`) using the credentials above, **complete the OAuth flow first**, then enter the **Owner Passphrase** at the consent screen. The default redirect URI is `https://claude.ai/api/mcp/auth_callback`.

### Update

```bash
slnctrz-mcp update
```

Update fetches the official HTTPS release manifest, validates redirect hops, streams the selected artifact, verifies size and SHA-256, and activates an immutable version. System mode restarts and health-checks the service.

### Rollback

```bash
slnctrz-mcp rollback
```

Rollback activates the recorded previous verified release. User state remains separate from immutable release binaries.

### Repair

```bash
slnctrz-mcp repair
```

Repair is intentionally limited. It may restore known non-secret launch/config assets, safe file modes, an absent minimal command catalog, or stale staging state. It does **not** silently replace a missing Owner Passphrase, delete customer policy/provider state, change authority, or roll back a release.

### Rotate the Owner Passphrase

```bash
slnctrz-mcp owner rotate-passphrase
```

The new passphrase is printed through the explicit CLI action and written to the recovery file. Restart the gateway afterwards so the active verifier uses the new credential.

### Uninstall

Program only, preserving config and state:

```bash
slnctrz-mcp uninstall --yes
```

Remove program and config, still preserve state:

```bash
slnctrz-mcp uninstall --yes --remove-config
```

Purge program, config, state, and credentials:

```bash
slnctrz-mcp uninstall --yes --purge
```

Destructive uninstall validates independent install-root and state identity markers before deleting managed roots. On System Install, the dedicated `slnctrz` OS account is intentionally retained because setup may have reused a pre-existing account and the product cannot safely prove exclusive ownership of that OS identity. Remove it manually only after confirming nothing else uses it.

## Backup and recovery

Persistent customer state is separate from the versioned standalone binary. Before major operational changes, back up the state/config roots while protecting secret permissions.

See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

## Troubleshooting

Start with:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
```

Common categories include:

- `installed_release_integrity_failed`;
- `running_version_mismatch`;
- `policy_invalid`;
- `command_catalog_invalid`;
- `path_os_permission_denied`;
- `owner_secret_permissions_unsafe`;
- `gateway_unreachable`.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Security and privacy

Important properties:

- owner configuration is separate from model-facing tools;
- Restricted mode defaults to no Commands on a fresh general-user setup;
- file roots are canonicalized and checked;
- `core.search` explicit-root scope is enforced within configured Paths;
- installer redirects are bounded and validated as HTTPS;
- release artifacts are checked by declared size and SHA-256;
- MCP credentials live behind a separate managed secret boundary;
- audit storage records bounded operational metadata rather than raw file contents or credential values.

Read [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before exposing the gateway publicly.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture contract
- [SECURITY.md](SECURITY.md) — current security contract
- [docs/MODEL_GUIDE.md](docs/MODEL_GUIDE.md) — instructions surfaced to connected AI models
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — local/system/public deployment
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — diagnosis and recovery
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) — persistence/backup contract
- [MCP_SERVERS.md](MCP_SERVERS.md) — owner provider configuration
- [MCP_PROVIDER_STANDARD.md](MCP_PROVIDER_STANDARD.md) — SlncTrZ provider integration convention
- [RELEASE.md](RELEASE.md) — build/publication/release process
- [docs/RELEASE_ACCEPTANCE.md](docs/RELEASE_ACCEPTANCE.md) — release evidence templates and claim rules
- [docs/OPERATIONAL_FILES.md](docs/OPERATIONAL_FILES.md) — production/release/developer/legacy operational-file classification
- [PROVENANCE.md](PROVENANCE.md) — dependency/license provenance

Historical ADRs live under `docs/adr/`. Living code and current product docs take precedence over superseded historical decisions.

## Development

Development requires Node `>=22.13.0 <25`.

```bash
npm ci
npm run check
npm run build
```

See [ENGINEERING.md](ENGINEERING.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
