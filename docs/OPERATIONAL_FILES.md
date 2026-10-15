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

`gateway.env` is read by the launcher through a fixed runtime-key allowlist, while
`client.env` holds the static OAuth client credential. On an operator-managed Linux user
service, reference `client.env` from the unit environment instead of copying those keys into
`gateway.env`; see [Deployment](DEPLOYMENT.md).

The proposed `lifecycle/operations.jsonl` belongs to the unwired ledger foundation, not
the current runtime's normal state layout. Runner/Coordinator records and context receipts
are in-memory. Custom harness roots require their own backup.

## Host Token state (ADR-030)

`<stateRoot>/secrets/host-tokens.sqlite3` contains hash-only live credentials and a
separate bounded metadata audit. Include this database and present WAL/SHM sidecars
in coherent private backups. Client-side plaintext secrets are not recoverable from it.
Credential deletion does not remove its independent audit events (newest 250,000 retained).

OAuth database schema/version is unchanged. An older binary ignores the new companion
file and cannot accept Host Tokens. Re-upgrading checks the 15-day inactivity boundary
before allowing access. Restoring an older backup can restore rows deleted after that
backup: reconcile/revoke affected token IDs before reopening network access.
