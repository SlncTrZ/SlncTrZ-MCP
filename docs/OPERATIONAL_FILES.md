# Operational Files

This inventory classifies security-sensitive scripts, configuration templates, and workflows shipped in the repository. It is part of the release review surface.

## Production / end-user runtime

| Path                                     | Classification                     | Purpose                                                                                       |
| ---------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `scripts/install.sh`                     | production bootstrap               | Public Linux x64 + Windows Git Bash bootstrap; target detection, checksum verification, setup |
| `config/systemd/slnctrz-mcp-launcher.sh` | production launcher                | Resolves active immutable SEA and parses strict non-secret runtime config keys                |
| `config/systemd/slnctrz-mcp.service`     | production System Install template | Dedicated `slnctrz` systemd service                                                           |
| `config/systemd/gateway.env.example`     | production/admin example           | Advanced non-secret runtime configuration example                                             |
| `config/commands.minimal.json`           | production default                 | Fresh general-user Restricted command catalog                                                 |
| `config/commands.json`                   | developer/source default           | Broader POSIX developer command catalog                                                       |
| `config/commands.win32.json`             | developer/source default           | Windows developer command catalog                                                             |

## Release / CI

| Path                                         | Classification                         | Purpose                                                                                                                      |
| -------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-sea.mjs`                      | release build                          | Native Linux x64 / Windows x64 SEA build + target metadata                                                                   |
| `scripts/release-gate.mjs`                   | release gate                           | Native target version/tag/build/hash/URL identity verification                                                               |
| `scripts/aggregate-release-manifest.mjs`     | release build                          | Aggregate verified Linux/Windows target metadata into canonical release manifest                                             |
| `scripts/clean-release-windows-user-e2e.ps1` | release acceptance                     | Exact public Git Bash → native Windows User Install lifecycle E2E, including Windows PowerShell 5.1 invocation compatibility |
| `scripts/clean-release-user-e2e.sh`          | release acceptance                     | Exact public GitHub Release bootstrap/User Install E2E                                                                       |
| `scripts/clean-release-system-e2e.sh`        | guarded destructive release acceptance | Disposable systemd-host System Install E2E; explicit opt-in required                                                         |
| `scripts/docs-check.mjs`                     | release/CI                             | Public documentation contract checks                                                                                         |
| `scripts/provenance-inventory.mjs`           | release/CI                             | Deterministic dependency/license inventory from lockfile                                                                     |
| `.github/workflows/ci.yml`                   | CI                                     | Source quality/security/provenance matrix                                                                                    |
| `.github/workflows/standalone.yml`           | release CI                             | SEA candidate → public User Install acceptance → release promotion                                                           |

## Developer-only

| Path                                              | Classification | Purpose                           |
| ------------------------------------------------- | -------------- | --------------------------------- |
| `scripts/check.mjs`                               | developer/CI   | Type/lint/format/test gate        |
| `scripts/benchmark.mjs`                           | developer      | Performance baseline              |
| `scripts/test-runner.mjs`                         | developer/CI   | Test orchestration                |
| `scripts/test-wrapper.mjs`                        | developer/CI   | Test wrapper                      |
| `scripts/validate-wrapper.mjs`                    | developer/CI   | Validation wrapper                |
| `scripts/verify-windows-native.mjs`               | developer/CI   | Native Windows verification       |
| `scripts/scan-reference-provenance.mjs`           | developer/CI   | Provenance/source hygiene scan    |
| `scripts/verify-no-derivative-implementation.mjs` | developer/CI   | Clean-room source hygiene check   |
| `scripts/verify-architecture.mjs`                 | developer/CI   | Architecture source hygiene check |
| `scripts/verify-spdx.mjs`                         | developer/CI   | License/SPDX checks               |

## Legacy migration / compatibility only

| Path                                  | Classification                | Purpose                                                                                                                                                                    |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/generate-owner-verifier.mjs` | **legacy compatibility only** | Generates pre-recovery-file `SLNCTRZ_OWNER_SECRET_HASH` verifier state. It is not the current owner credential setup path and prints a legacy warning on every invocation. |

Current deployments use the managed Owner Passphrase recovery file:

```text
<stateRoot>/secrets/owner-passphrase
```

The legacy verifier script must not appear in Quick Start, System Install, or ordinary recovery instructions.

## Obsolete

No known obsolete operational file is intentionally shipped in the current release line. If a file no longer has a production, release, developer, or migration role, remove it rather than leaving an unclassified alternate security path.

## Release review rule

Before each public release:

1. review every new/changed file under `scripts/`, `config/`, and `.github/workflows/`;
2. assign one of the classifications above;
3. ensure public docs reference only current production paths;
4. ensure legacy tooling cannot be mistaken for normal setup;
5. run `npm run docs:check`, source gates, standalone release gate, and the acceptance appropriate to the claimed support level.
