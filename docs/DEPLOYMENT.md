# Deployment Guide

Deployment contract for SlncTrZ-MCP (v0.5.x source). Verify published and running identities
separately; [Project Status](PROJECT_STATUS.md) records current evidence.

## 1. Linux System Install (systemd)

`--mode system` needs sudo, systemd and an existing workspace. Defaults:

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
Review Owner Console enablement, accepted hosts/origins and proxy configuration explicitly.

## 4. Task Runtime lifecycle

The gateway's graceful SIGTERM/SIGINT shutdown requests termination of supervised child
runners and closes servers/stores. User foreground instances should be stopped through
their owning terminal; System installs through systemctl.

Tasks and context receipts reset on restart. A forced kill, host crash or independent remote
provider process has different cleanup behavior; reconcile effects before starting replacement
work. Updating files in a source tree does not restart or deploy a running installed gateway.
