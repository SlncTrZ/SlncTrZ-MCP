# User Guide

Install, connect and use the published gateway. Stable release: v0.4.2 as observed on
2026-10-09. This development tree also contains unreleased changes; see
[Project Status](PROJECT_STATUS.md) before assuming an installed binary has them.

## 1. Installation & Endpoints

Release targets are Linux x64 and Windows x64 with Git Bash for the installer bootstrap
(`install.sh`). Installed SEA binaries include Node; Git Bash/npm are not required to run the
Windows gateway.

| Mode         | Program                    | State                      | Config                |
| ------------ | -------------------------- | -------------------------- | --------------------- |
| Linux User   | ~/.local/share/slnctrz-mcp | ~/.slnctrz-mcp             | ~/.config/slnctrz-mcp |
| Windows User | %LOCALAPPDATA%\SlncTrZ-MCP | %USERPROFILE%\.slnctrz-mcp | %APPDATA%\SlncTrZ-MCP |
| Linux System | /opt/slnctrz-mcp           | /var/lib/slnctrz-mcp       | /etc/slnctrz-mcp      |

Windows System Install is unsupported. Linux System Install needs separate systemd-host
acceptance for a verified release claim.

- Owner homepage: `http://127.0.0.1:3100/`; compatible link: `http://127.0.0.1:3100/owner`.
- Client MCP endpoint: `http://127.0.0.1:3100/mcp`.
- Owner-authenticated control plane: loopback port 3101 by default; keep it private.

Cloud clients require a reachable HTTPS MCP URL. Follow [Deployment](DEPLOYMENT.md) and
use the setup-generated `Start:` command. User installs run in the foreground;
stop that instance with Ctrl+C, then execute the same command to restart. Linux System
installs use systemctl. There are no standalone CLI `start` or `stop` subcommands.

### Install on Linux

Use an x64 Linux account with `sh`, `curl`, `sha256sum`, `mktemp`, `grep` and `uname`.
Choose an existing absolute project directory; the installer does not create your workspace.

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh
sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "$HOME/projects"
```

Run the exact `Start:` line printed by setup. Keep the terminal open while the gateway runs.
User mode needs no system service. For a managed service, follow
[Linux System Install](DEPLOYMENT.md#1-linux-system-install-systemd).

### Install on Windows

Use **Git Bash**, not PowerShell, for the installer bootstrap command (`install.sh`). Git Bash
supplies the POSIX tools and `cygpath`. Choose an existing directory and use an absolute Git
Bash path:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh
sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "/c/Users/YourName/projects"
```

After setup, use its `Start:` executable path. In PowerShell, paths with spaces need the call
operator and quotes. For the default layout:

```powershell
& "$env:LOCALAPPDATA\SlncTrZ-MCP\slnctrz-mcp.exe"
```

If you selected a custom install root, use the path printed by setup instead. The running
binary needs neither Git Bash nor a separately installed Node.js. Keep its terminal open;
Ctrl+C stops that foreground instance.

### Open the Console and check success

1. Open the `Owner Console:` URL printed by setup; local default:
   `http://127.0.0.1:3100/`.
2. Setup prints the **Passphrase file** path, not its value. Read that file privately on your
   machine and enter the passphrase in the browser. Do not paste it into chat or support logs.
3. Review Paths/Commands before enabling coding work and MCP Servers before using providers.
4. Use the installed launcher/executable to run `status --json` and `doctor --json`;
   confirm the version, running identity and any reported issues.

`/mcp` is the client endpoint; the homepage is the Owner UI. The private port 3101 is neither
of those endpoints. If port 3100 is already in use, select another `--port` at setup and use
the printed URLs. See [Troubleshooting](TROUBLESHOOTING.md).

### Connect an AI Web client

Cloud clients cannot reach your computer's `127.0.0.1`. Configure a reachable HTTPS endpoint
using [Deployment](DEPLOYMENT.md#3-public-https), including its OAuth routes.

| Client     | Add the server                                                                                                              | Complete the connection                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ChatGPT    | In Plugins, use Add custom MCP server, enter your HTTPS `/mcp` URL and configure OAuth; create/install the resulting plugin | Select the plugin with `@` in a new chat, complete gateway consent and ask for `core.ping`                         |
| Claude Web | In Customize → Connectors, add a custom Web connector with your HTTPS `/mcp` URL and OAuth                                  | Use automatic client registration for this gateway's existing DCR flow; connect and enable it for the conversation |

Client UI labels and account/admin policies can change. These are documentation-based
recipes checked on 2026-10-09, not named-account end-to-end acceptance. Consult the official
[ChatGPT MCP/plugin steps](https://developers.openai.com/plugins/deploy/connect-chatgpt) and
[Claude connector steps](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
This guide covers public HTTPS; vendor-specific private tunnels require their own setup.

On the gateway consent page, choose **Full** for gateway coding tools/harness or
**Gateway-only** for providers and Debate. After approval, ask the client to call `core.ping`
and inspect the profile/tool inventory. A successful server add is not yet a successful tool
call. Coding-agent recipes and verification levels are in [Gateway-only](GATEWAY_ONLY.md).

### Keep the three authentication roles separate

| Role                | What it authorizes                                   | Where it belongs                                           |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| Owner passphrase    | Owner Console and approval of gateway connections    | Enter privately in the gateway browser UI                  |
| Client OAuth        | An AI client's approved gateway profile and access   | Let that client's OAuth flow manage credentials            |
| Provider credential | Access from the gateway to a downstream MCP provider | Configure through the provider's supported credential flow |

Do not use an Owner passphrase as a bearer header or copy client/provider secrets into
project config, examples or chat. Normal dynamic OAuth setup uses the MCP URL and browser
consent; it does not require copying setup's static client credentials.

## 2. CLI Commands

Use the installed launcher/executable path printed by setup if it is not on PATH.

```bash
slnctrz-mcp --help
slnctrz-mcp --version
slnctrz-mcp --build-info
slnctrz-mcp status --json
slnctrz-mcp doctor --json
slnctrz-mcp config show
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

Update, rollback, config changes and passphrase rotation can require restart. Check the
command's result and rerun status/doctor afterward. Repair performs bounded safe repairs;
it is not a generic recovery tool for corrupted databases. Preserve a backup before recovery.

| Uninstall command                             | Program | Config   | State    |
| --------------------------------------------- | ------- | -------- | -------- |
| `slnctrz-mcp uninstall --yes`                 | Remove  | Preserve | Preserve |
| `slnctrz-mcp uninstall --yes --remove-config` | Remove  | Remove   | Preserve |
| `slnctrz-mcp uninstall --yes --purge`         | Remove  | Remove   | Remove   |

Stop your running User gateway before uninstall. Windows self-removal is deferred until
the uninstall process exits. A successful ready handshake confirms helper startup, not
completed deletion; verify the managed paths afterward. Startup failure preserves managed
files and reports an error. Legacy/shared layouts protect retained roots.

## 3. Releases & Integrity

Release status is determined by the published GitHub release, not package version alone.
Setup/update authenticates the manifest against the Ed25519 trust root, then verifies the
binary's declared size and SHA-256 before activation. This is manifest signing; Windows
Authenticode signing is not claimed.

Before upgrading a pre-schema-v3 installation, stop the gateway and back up state plus config coherently. OAuth
schema v1/v2 migrates to v3; existing grants keep finite lifetimes and profiles. Rollback to a
pre-v3 binary needs the pre-migration backup, not binary-only rollback. See [Backup](BACKUP_RESTORE.md).

## 4. Core Tools

Full connections expose tools according to authority:

- `core.read`: Strict UTF-8 text read; `media.read_image` handles PNG/JPEG.
- `core.search`: Case-insensitive file/directory and bounded text search.
- `core.write`, `core.edit`: Atomic updates; supply `dryRun:true` for preview.
- `core.exec`: Bounded commands under the current autonomy policy.

Restricted applies Paths and the command catalog; Autonomous follows the gateway OS account.
A catalog-authorized shell is not an OS sandbox. Gateway-only hides coding/context/task
tools and retains enabled providers, Debate and connection self-restriction.

### Connection controls and result delivery

In the Owner Console's Connections panel, mode and content changes save immediately.
Click the edit icon, enter a name and press Enter to save; Escape cancels. `SAVED` appears
after the server confirms the change. If saving cannot be confirmed, reload to verify
the stored state before retrying.

Each connection defaults to a checked **StructuredContent** checkbox. Checked keeps
the existing tool text and complete `structuredContent`. Unchecked selects **FullContent**:
the gateway also appends the complete structured result as JSON text for clients that
only display `content[].text`, while preserving existing text, images and error metadata.
This includes `core.exec` stdout/stderr within the tool's existing output limits.
Result delivery is independent of Full / Gateway-only mode and is stored per connection,
surviving token refresh and gateway restart. Changes apply to subsequent requests.
OAuth redirect URIs do not select this setting.

## 5. Agent Context & Skills

`context.bootstrap` here is the Full-profile MCP tool that returns a harness context receipt;
it is distinct from the installer bootstrap (`install.sh`) used in section 1 to install the
gateway software. Only Full connections call it.

Call `context.bootstrap` before Full coding work and read its instructions/catalog.
Pass its receipt as `slnctrzContext`; load a needed skill with `skills.read` before requesting
its resources. Re-bootstrap after expiry, restart, policy or instruction changes.

Gateway-only connections skip context.bootstrap and slnctrzContext and use enabled providers
and Debate directly.

Fresh installs seed code-review/debug-and-test only. Additional repository skills require
explicit project discovery or owner installation. See [Harness](HARNESS.md).

## 6. Tasks and Debates

`task.start` runs a bounded background command; get/wait/cancel operate on the creator's Runner.
`task.create` creates a workspace-visible logical task for another client to claim; it does not
execute a process. Task state is in-memory and clears on restart. Reconcile any previous
effects before recreating work.

Two-participant Debate history persists in SQLite. Instructions in a task or debate do not
grant permissions. The lifecycle ledger foundation does not make these tasks durable.
