# Changelog

User-visible product changes are recorded here. Internal commit history is not a substitute for release notes.

## 0.1.1 — First Release SlncTrZ - MCP

Date: 2026-09-04

First public release snapshot of the SlncTrZ - MCP product. Includes the full standalone runtime, Owner Console, extension tool identity/namespacing, release/distribution harness, and Windows x64 build support.

- Single cleaned history snapshot tagged as the project's first release.
- Extension tool dispatch namespace-aware (canonical `provider.tool` vs provider-local bare names).
- Standalone installer with immutable version activation and Windows-aware path handling.
- Owner Console with restricted/autonomous modes and MCP provider management.

## 0.3.0 — Windows x64 end-user distribution

Date: 2026-09-04

### Added

- native `win32-x64` SEA build, smoke and release-identity gates on a Windows runner;
- multi-target Linux/Windows release-manifest aggregation;
- one-command Windows User Install through Git Bash with native path conversion;
- native installed Windows launcher/delegation without a Node.js/npm/runtime Git Bash dependency;
- Windows-aware install/config/state layout;
- clean hosted Windows User Install acceptance;
- Windows-specific setup/run/status/doctor/uninstall, ACL and recovery coverage;
- Windows installation and troubleshooting documentation.

### Distribution policy

- Windows x64 User Install is an advertised prebuilt target from 0.3.x only after the hosted prerelease clean-install gates pass.
- Windows System Install/service mode remains unsupported.
- The first Windows release is allowed to be unsigned; SHA-256 and GitHub release provenance are mandatory. Authenticode signing can be added later as a separate distribution-hardening tier.
- Git Bash is bootstrap-only; the installed runtime is native `slnctrz-mcp.exe`.

## 0.2.0 — release candidate

Date: 2026-09-04

### Added

- secure bounded HTTPS redirect handling for release manifest/artifact downloads;
- standalone runtime assets for command catalogs and systemd launcher/service setup;
- product `setup` flow for User/System installs;
- first-run Owner Passphrase handoff + stable recovery path;
- local mode without mandatory public HTTPS URL;
- explicit Restricted/Autonomous setup;
- minimal empty Restricted command defaults for general-user installs;
- production SEA systemd service orchestration with dedicated `slnctrz` account;
- `status`, `doctor`, `config`, `update`, product-level `rollback`, `repair`, passphrase rotation, and safe uninstall;
- independent install-root/state identity markers for destructive lifecycle safety;
- installed-vs-running authenticated build/version comparison;
- Owner Console Overview + Autonomy management;
- human-facing README and separated embedded model guide;
- public Linux x64 bootstrap and staged GitHub prerelease/public-install/promotion workflow;
- clean User Install and guarded disposable-host System Install acceptance scripts;
- SlncTrZ MCP Provider Standard draft v0.2.

### Fixed

- Restricted `core.search` explicit-root behavior across multiple configured Paths;
- global search result/entry/time/cancellation accounting;
- GitHub-style release redirects no longer fail merely because a valid HTTPS 302 hop is present;
- standalone/systemd deployment-model mismatch;
- stale mandatory `owner.env` service assumption;
- standalone missing runtime resource dependency;
- local Owner Console cookie behavior over loopback HTTP;
- documentation drift around dry-run defaults, Windows `core.exec`, systemd packaging, ADR status, and runtime dependencies.

### Security / behavior notes

- Restricted mode remains a capability policy, not an OS sandbox.
- Fresh Restricted setup does not enable shells/interpreters by default.
- Autonomous mode follows the runtime OS-user authority.
- Owner Passphrase plaintext is shown only during explicit first-run/rotation flows.
- Repair does not silently replace missing credentials or customer policy/provider state.
- Default uninstall preserves state/config.

### Release evidence status

0.2.0 must not be promoted as broadly verified until the release-specific required evidence exists. In particular, named ChatGPT/Claude support and verified System Install support require their respective real-client/clean-systemd-host acceptance records.
