# Operational Files Reference

Quick index of configuration and script assets in the repository.

---

## 1. Setup & Automation Scripts

| Path                                         | Purpose                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/install.sh`                         | Linux and Windows Git Bash public installer                                    |
| `scripts/clean-release-windows-user-e2e.ps1` | Validates Windows PowerShell 5.1 invocation compatibility during release gates |
| `config/systemd/slnctrz-mcp.service`         | Linux systemd service template                                                 |
| `config/commands.json`                       | Approved binaries whitelist for Restricted mode                                |

---

## 2. Persistent State Layout

- `installation.json`, `policy.json`, `command.json`: Active execution policies.
- `oauth-grants.sqlite3`: Client authorization tokens and grant profiles.
- `debate.sqlite3`, `audit.sqlite3`: Debate archives and security audit trail.
