# Deployment

This guide covers where the gateway runs, how to start it, and how to expose it to clients.
For installation, start with [Quick start](../README.md#quick-start).
Use the paths printed by setup if you selected custom locations.

## Choose an installation mode

| Mode                 | Startup                      | Suitable for                    |
| -------------------- | ---------------------------- | ------------------------------- |
| Linux User Install   | Foreground launcher          | Local use and evaluation        |
| Windows User Install | Native foreground executable | Windows workstations            |
| Linux System Install | systemd service              | An always-running Linux gateway |

Windows System Install/service mode is not currently supported. The standalone builds include
their runtime; source/developer installs require Node `>=22.13.0 <25`.

### Linux User Install

Default locations:

```text
install: ~/.local/share/slnctrz-mcp
state:   ~/.slnctrz-mcp
config:  ~/.config/slnctrz-mcp
```

User mode does not create a service. Use the `Start:` command printed by setup:

```bash
SLNCTRZ_CONFIG_FILE="$HOME/.config/slnctrz-mcp/gateway.env" \
  "$HOME/.local/share/slnctrz-mcp/slnctrz-mcp-launcher"
```

Keep that process running. Stop it gracefully before a backup or restart.

### Windows User Install

Use Git Bash for `install.sh`; setup converts MSYS paths with `cygpath -w`.
The installed gateway is native Windows and needs neither Git Bash nor system Node.js afterward.

```text
install: %LOCALAPPDATA%\SlncTrZ-MCP
state:   %USERPROFILE%\.slnctrz-mcp
config:  %APPDATA%\SlncTrZ-MCP
launcher: %LOCALAPPDATA%\SlncTrZ-MCP\slnctrz-mcp.exe
```

For default locations, start it from PowerShell:

```powershell
& "$env:LOCALAPPDATA\SlncTrZ-MCP\slnctrz-mcp.exe"
```

Keep the process running; setup does not install a Windows background service.

### Linux System Install

Requires sudo/root for installation and an operational systemd service manager.
The runtime account is the real non-root invoking user, resolved from validated `SUDO_USER`;
setup does not create a dedicated service account.

```text
install: /opt/slnctrz-mcp
state:   /var/lib/slnctrz-mcp
config:  /etc/slnctrz-mcp
service: slnctrz-mcp.service
```

Setup enables/starts the service and checks health. Verify it with:

```bash
systemctl status slnctrz-mcp.service
slnctrz-mcp status
slnctrz-mcp doctor
```

For restart and logs:

```bash
sudo systemctl restart slnctrz-mcp.service
journalctl -u slnctrz-mcp.service
```

The service runs the immutable SEA through its generated launcher. It does not depend on
a source checkout, `dist/`, or `/usr/bin/node`. Hosts without systemd should use User Install.

## Choose the initial Path and authority

Setup requires an existing readable directory. Pass `--path` explicitly for predictable results.
User setup otherwise defaults to its current working directory; System Install requires an
explicit Path and checks read/write access as the resolved runtime user.

Configured Paths do not override OS permissions. Use a project/workspace directory instead of
granting an entire home directory by default.

| Authority  | Files and commands                                                           |
| ---------- | ---------------------------------------------------------------------------- |
| Restricted | File tools use Paths; command starts use the compiled `command.json` catalog |
| Autonomous | Tools follow the gateway account's OS permissions                            |

Fresh Restricted setup filters the shipped Linux/Windows command candidates to executables
available to the runtime account. Review the persisted Commands in the Owner Console.
Neither mode silently elevates privileges; shells/interpreters can exercise the account's rights.
See [Autonomy](AUTONOMY.md).

## Local mode

Local mode is the default: listener `127.0.0.1:3100`, no public URL.

```text
MCP:   http://127.0.0.1:3100/mcp
Owner: http://127.0.0.1:3100/owner
Usage: http://127.0.0.1:3100/usage
```

Loopback HTTP is allowed for local OAuth/Owner use. A cloud-hosted client cannot reach your
machine's loopback address.

## Public HTTPS mode

1. Configure a trusted HTTPS reverse proxy or tunnel to the gateway listener.
2. Use the installer option `--public-url https://mcp.example.com/mcp`, or configure an existing installation:
   ```bash
   slnctrz-mcp config set public-url https://mcp.example.com/mcp
   ```
3. Check `slnctrz-mcp config show`, restart the gateway as instructed by the CLI, then connect
   the client to the public endpoint.
4. Check Host/Origin configuration if the proxy receives 403 responses.

The URL must use HTTPS and the exact path `/mcp`, with no userinfo, query or fragment.
The public URL advertises MCP/OAuth identity; it does not force the listener to bind to a public
interface. A proxy on the same host can forward to `127.0.0.1:3100`.

Forward the original public Host correctly. The public hostname must be accepted by
`SLNCTRZ_ALLOWED_HOSTS`; a public Owner Console also needs its origin accepted by
`SLNCTRZ_ALLOWED_ORIGINS`. Host/Origin checks run before Owner, OAuth and MCP dispatch.
Do not bypass these checks with wildcards or by disabling verification.

The separate control plane is loopback-only (default port 3101). **Do not publish it through
the proxy.** Use HTTPS for public Owner access and keep the passphrase private.

Failed Owner authentication is counted by direct socket peer, without trusting forwarded
client-IP headers. Clients behind one proxy/tunnel can share a failure bucket; an exhausted
bucket temporarily blocks that peer. Apply per-client abuse controls at a trusted edge if needed.

## Change runtime configuration

Use the installed CLI; use its absolute executable path if it is not on PATH.

```bash
slnctrz-mcp config show
slnctrz-mcp config set port 3200
slnctrz-mcp config set host 127.0.0.1
slnctrz-mcp config set public-url local
slnctrz-mcp config set owner-console true
```

These are examples of separate changes. Read the CLI's restart requirement before continuing.
`gateway.env` uses a strict supported-key parser, not shell execution; do not add shell commands
or source/eval it. The private static OAuth client configuration is in `client.env`.

## Check health

| Endpoint       | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `GET /healthz` | Process liveness                                            |
| `GET /readyz`  | Active policy snapshot can be captured; failure returns 503 |

Liveness/readiness intentionally do not require the Origin gate. They do not prove every provider
is healthy or that an AI client has completed OAuth. Use `status`, `doctor` and `core.ping`
for installed/running identity and capability checks.

## Task Runtime lifecycle

On graceful SIGTERM/SIGINT shutdown, the gateway stops accepting work, cancels active Runner
process trees and closes owned resources. Forced termination may prevent that cleanup.

Runner/Coordinator tasks and context receipts are in memory and reset on restart/update/rollback.
Debate history and turn state persist in `debate.sqlite3`; turn deadlines still apply.
Full connections call `context.bootstrap` after restart; Gateway-only connections do not expose
coding context. See [User Guide](USER_GUIDE.md).

## Instructions, backups and updates

Editable global guidance is under `<stateRoot>/harness/`. Set `SLNCTRZ_HARNESS_ROOT` to an
absolute accessible directory for a custom root; this does not grant Paths or Commands.
Receipts expire after four hours or relevant changes. Refresh client discovery after upgrades.

Back up state/config and custom harness roots before lifecycle changes:
[Backup and Restore](BACKUP_RESTORE.md).
Obtain the first installer/binary through a trusted release path; subsequent signing-enabled
updates verify publisher-signed manifests before parsing and verify artifact size/SHA-256.
Signing keys belong to release infrastructure, not a deployed gateway:
[Security](../SECURITY.md), [Release Process](../RELEASE.md).

For source development, use `npm ci`, `npm run build`, and `npm start` on supported Node.
Keep that workflow separate from standalone deployment.
