# Operational Files Reference

Paths come from the installed metadata and OS-specific layout, not a developer checkout.
Use config show/status to locate your actual installation; do not expose secret-file contents.

## 1. Setup & Automation Scripts

| Path                                          | Purpose                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `scripts/install.sh`                          | Linux and Windows Git Bash public bootstrap                                           |
| `scripts/clean-release-user-e2e.sh`           | Exact public Linux User Install acceptance                                            |
| `scripts/clean-release-windows-user-e2e.ps1`  | Exact public Windows User Install and Windows PowerShell 5.1 invocation compatibility |
| `scripts/clean-release-usage-browser-e2e.sh`  | Installed public candidate Usage browser acceptance                                   |
| `scripts/clean-release-system-e2e.sh`         | Opt-in disposable Linux systemd acceptance                                            |
| `scripts/smoke-sea.mjs`                       | Isolated native gateway, OAuth and embedded harness smoke                             |
| `scripts/smoke-uninstall.mjs`                 | Disposable native uninstall/retention matrix                                          |
| `scripts/release-gate.mjs`                    | Native version/build/manifest/hash identity                                           |
| `scripts/docs-check.mjs`                      | Public documentation contracts and local navigation                                   |
| `scripts/provenance-inventory.mjs`            | Deterministic lockfile dependency/license inventory                                   |
| `config/systemd/slnctrz-mcp.service`          | Linux service template                                                                |
| `config/commands.json`, `commands.win32.json` | Platform-specific command seeds; not guaranteed installed binaries                    |

## 2. Persistent State Layout

| Path under stateRoot                                | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `installation.json`                                 | Install metadata and managed-root identity                     |
| `policy.json`, `command.json`                       | Owner Paths/autonomy/provider authority and allowed commands   |
| `mcp/providers.json`, `mcp/credentials/`            | Provider definitions and separate sensitive credential storage |
| `secrets/owner-passphrase`                          | Sensitive Owner recovery/authentication material               |
| `oauth-grants.sqlite3`                              | Hashed token/grant families, profiles and labels               |
| `oauth-clients.json`, `oauth-static-redirects.json` | Dynamic client registrations and static redirect state         |
| `debate.sqlite3`, `audit.sqlite3`, `usage.sqlite3`  | Debate, bounded security audit and numeric traffic records     |
| `lifecycle-intent.json`                             | Existing owner-managed mutation recovery intent                |
| `harness/AGENTS.md`, `harness/skills/`              | Global instructions and progressive skills                     |

Config root contains `gateway.env` and sensitive `client.env`. Program root contains
immutable `versions/`, atomic `current.json`, installation-marker.json and a platform launcher.

The proposed `lifecycle/operations.jsonl` belongs to the unwired ledger foundation, not
the current runtime's normal state layout. Runner/Coordinator records and context receipts
are in-memory. Custom harness roots require their own backup.
