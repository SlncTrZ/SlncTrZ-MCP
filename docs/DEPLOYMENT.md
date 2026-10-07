# Deployment Guide

Deploying SlncTrZ-MCP (v0.3.x) on Linux and Windows.

---

## 1. Linux System Install (systemd)

`--mode system` needs sudo, systemd and an existing workspace directory. Defaults:

- Program: `/opt/slnctrz-mcp`
- State: `/var/lib/slnctrz-mcp`
- Config: `/etc/slnctrz-mcp`

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sudo sh /tmp/slnctrz-install.sh --mode system --port 3100 --path /srv/slnctrz-workspace
sudo systemctl status slnctrz-mcp
```

A `--mode user` install creates no systemd unit: start it with the `Start:` command printed by setup.

---

## 2. Windows User Install

- Install under your own account from Git Bash or PowerShell; no Administrator escalation.
- Program: `%LOCALAPPDATA%\SlncTrZ-MCP`; state: `%USERPROFILE%\.slnctrz-mcp`; config: `%APPDATA%\SlncTrZ-MCP`.

---

## 3. Task Runtime lifecycle

- Child processes and background runners are supervised by the gateway.
- On service stop or restart, the gateway performs a graceful SIGTERM/SIGINT shutdown to terminate child processes cleanly without leaving zombie jobs.
