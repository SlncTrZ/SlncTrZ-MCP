# Operational files

This reference is for contributors and release reviewers. It identifies which repository
files are installer/runtime assets, release gates, developer helpers or legacy tools.
Operators should start with [Deployment](DEPLOYMENT.md) and [Backup and Restore](BACKUP_RESTORE.md).

## Installed runtime and provisioning

| Repository path                          | Role                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/install.sh`                     | Linux/Windows Git Bash public bootstrap, target selection, checksum and native setup |
| `config/systemd/slnctrz-mcp-launcher.sh` | Linux launcher resolving the active SEA and parsing supported runtime config         |
| `config/systemd/slnctrz-mcp.service`     | System Install template rendered for the invoking runtime user                       |
| `config/systemd/gateway.env.example`     | Non-secret advanced configuration example                                            |
| `config/commands.json`                   | Linux command candidates filtered to locally available executables                   |
| `config/commands.win32.json`             | Windows command candidates filtered to locally available executables                 |
| `scripts/ensure-skills-dir.mjs`          | Source postinstall creates the repository skills directory                           |

Current Owner credential setup uses `<stateRoot>/secrets/owner-passphrase`.
The private static OAuth client configuration is `<configRoot>/client.env`.

## Persistent data

| Path under state root                               | Data and backup role                                       |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `installation.json`                                 | Installation identity and locations                        |
| `policy.json`, `command.json`                       | Owner-managed authority                                    |
| `mcp/providers.json`, `mcp/credentials/`            | Provider definitions and private credentials               |
| `secrets/owner-passphrase`                          | Owner credential                                           |
| `oauth-clients.json`, `oauth-static-redirects.json` | Durable client and approved redirect state                 |
| `oauth-grants.sqlite3`                              | Grants, token hashes, connection profiles and labels       |
| `debate.sqlite3`                                    | Actual Debate content and membership/turn state            |
| `audit.sqlite3`                                     | Security/attribution metadata                              |
| `usage.sqlite3`                                     | Bounded traffic/context estimates; optional history backup |
| `harness/`                                          | Owner-edited instructions, skills and seeding marker       |
| `lifecycle-intent.json`                             | Managed lifecycle coordination when present                |

Debate history intentionally stores conversation content. Audit and usage exclude raw payloads.
None of these are interchangeable authorization/telemetry stores. Stop/quiesce before ordinary
file-copy backups and retain any SQLite sidecars.

## Release and CI

| Path                                         | Role                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `scripts/build-sea.mjs`                      | Native SEA build and embedded release identity/resources                     |
| `scripts/smoke-sea.mjs`                      | Packaged runtime smoke                                                       |
| `scripts/release-gate.mjs`                   | Binary/manifest/tag/build/hash identity gate                                 |
| `scripts/aggregate-release-manifest.mjs`     | Multi-target manifest/checksum aggregation                                   |
| `scripts/sign-release-file.mjs`              | Ed25519 release-file signing in protected CI                                 |
| `scripts/clean-release-user-e2e.sh`          | Exact public Linux User Install acceptance                                   |
| `scripts/clean-release-windows-user-e2e.ps1` | Native Windows lifecycle and Windows PowerShell 5.1 invocation compatibility |
| `scripts/clean-release-system-e2e.sh`        | Guarded destructive acceptance on a disposable systemd host                  |
| `scripts/clean-release-usage-browser-e2e.sh` | Install exact public candidate for browser acceptance                        |
| `scripts/usage-browser-e2e.mjs`              | Chromium Owner/Usage dashboard checks                                        |
| `scripts/release-workstation-preflight.ps1`  | Windows release workstation prerequisites                                    |
| `scripts/docs-check.mjs`                     | Documentation/CLI contract checks                                            |
| `scripts/provenance-inventory.mjs`           | Locked dependency/license inventory                                          |
| `.github/workflows/ci.yml`                   | Source quality/provenance matrix                                             |
| `.github/workflows/standalone.yml`           | Native builds, signed candidate, clean installs/browser gates, promotion     |
| `.github/workflows/release-metadata.yml`     | Synchronize canonical release-note content                                   |

Signing private keys are CI-only secrets; never include them in runtime state or release assets.
Do not run the destructive system acceptance script on a production gateway.

## Developer helpers

| Path                            | Role                                 |
| ------------------------------- | ------------------------------------ |
| `scripts/check.mjs`             | Typecheck, lint, format and tests    |
| `scripts/benchmark.mjs`         | Runtime cold-start/readiness samples |
| `scripts/benchmark-harness.mjs` | Harness workload measurements        |
| `scripts/bump-version.mjs`      | Version update workflow              |
| `scripts/version.mjs`           | Shared version/release-line helpers  |

## Legacy compatibility

| Path                                  | Role                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `scripts/generate-owner-verifier.mjs` | Legacy pre-recovery-file verifier generation; not current setup/recovery |
| `config/commands.minimal.json`        | Historical empty catalog; current setup/repair use platform discovery    |

Legacy tools must not appear as ordinary installation/recovery instructions.

## Release review

When adding or changing files under `scripts/`, `config/` or `.github/workflows/`:

1. Classify their role here and verify referenced paths exist.
2. Keep operator guides on supported production paths.
3. Check secret handling and distinguish legacy/developer tools from installed product actions.
4. Run `npm run docs:check` plus source/release gates appropriate to the change.
5. Record acceptance for the actual artifact; a listed gate is not a passing result.
