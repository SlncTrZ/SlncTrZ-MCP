# Deployment Guide

For a foreground User install, start with [User Guide](USER_GUIDE.md#1-installation--endpoints).
Use this guide for a Linux system service or a reachable HTTPS endpoint. Published baseline:
v0.4.2; development changes and running identities are tracked in [Project Status](PROJECT_STATUS.md).

## 1. Linux System Install (systemd)

Use an x64 Linux systemd host with the bootstrap tools listed in [User Guide](USER_GUIDE.md#install-on-linux).
`--mode system` needs sudo and an existing absolute workspace directory. Defaults:

- Program: `/opt/slnctrz-mcp`
- State: `/var/lib/slnctrz-mcp`
- Config: `/etc/slnctrz-mcp`

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sudo sh /tmp/slnctrz-install.sh --mode system --port 3100 --path /srv/slnctrz-workspace
sudo systemctl status slnctrz-mcp
sudo systemctl restart slnctrz-mcp
```

The service runs as the validated invoking account; sudo setup is not permission to run
the gateway as root. Claim System Install support only with disposable-systemd-host evidence.

## 2. User Installs

Linux User Install creates no systemd unit. Start with the setup-generated launcher command
and stop the foreground process with Ctrl+C.

Windows bootstrap uses Git Bash; there is no published PowerShell installer. A downloaded
native executable's setup/management commands can be invoked from PowerShell. Use the
setup-generated `Start:` command to launch it without Administrator escalation.

Windows program: `%LOCALAPPDATA%\SlncTrZ-MCP`; state: `%USERPROFILE%\.slnctrz-mcp`;
config: `%APPDATA%\SlncTrZ-MCP`. The installed runtime does not require Git Bash or Node.
Windows System Install/service mode is unsupported.

## 3. Public HTTPS

Keep the origin bound to loopback unless your network design requires otherwise. Configure
the public MCP URL to match the HTTPS URL presented to OAuth clients, for example:

```bash
slnctrz-mcp config set public-url https://mcp.example.com/mcp
```

Restart the installed gateway when the command reports it, and ensure your tunnel/reverse
proxy routes the required OAuth discovery, authorization, registration and token endpoints
as well as /mcp. Expose neither the private control plane nor unrestricted owner state.
The public URL must be HTTPS and end exactly at `/mcp`. Restart through the owning terminal
or systemd after the config change; check `status --json`, `doctor --json` and discovery again.

Public URL configuration does not create a tunnel, DNS record or reverse proxy. Forward the
OAuth discovery/registration/authorization/token routes on the same public origin, not just
`/mcp`. Check reachability from the client network; a browser on your own computer is not
proof that a cloud client can reach it.

Review Owner Console enablement and allowed hosts/origins separately. When no explicit
Owner setting exists, configuring a public URL disables Owner Web by default. You can
explicitly use `slnctrz-mcp config set owner-console true` if you intend to expose that UI;
review its network/access policy before doing so. Keep port 3101 loopback/private. Do not
enable the UI or edit credentials merely to diagnose client OAuth.
See [AI Web connection steps](USER_GUIDE.md#connect-an-ai-web-client).

## 4. Task Runtime lifecycle

The gateway's graceful SIGTERM/SIGINT shutdown requests termination of supervised child
runners and closes servers/stores. User foreground instances should be stopped through
their owning terminal; System installs through systemctl.

Tasks and context receipts reset on restart. A forced kill, host crash or independent remote
provider process has different cleanup behavior; reconcile effects before starting replacement
work. Updating files in a source tree does not restart or deploy a running installed gateway.
