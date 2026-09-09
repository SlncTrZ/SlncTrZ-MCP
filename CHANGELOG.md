# Changelog

User-visible product changes are recorded here. Internal commit history is not a substitute for release notes.

## 0.3.0

Date: 2026-09-09

### Added

- Automatic global AGENTS.md discovery with optional authorized project instructions.
- Mandatory coding-context bootstrap receipts for ordinary gateway tools; argument and MCP metadata delivery.
- Agent Skills catalog, activation and on-demand text resources with bounded YAML/filesystem validation.
- Preserved global installation layout and bundled code-review/debug-and-test skills.
- Coding-agent integration guide, migration/help guidance and authenticated legacy/modern conformance coverage.
- Original PNG/JPEG reads with client image-display guidance carried forward from the image feature branch.

### Changed

- Product positioning moves from a capability gateway to a coding harness over MCP.
- Clients upgrading from 0.2 must refresh tools and bootstrap context before ordinary work calls.
- ADR-027 supersedes ADR-009's manual instruction-source declaration and delivery design.

### Fixed

- Policy-generation changes now reclaim stale coding-context receipts before enforcing the bounded receipt capacity, preventing old live-TTL receipts from blocking a fresh bootstrap.
- Harness tool annotations now distinguish read-only catalog inspection from bootstrap/close/skill-activation calls that mutate in-memory context state.

## 0.2.10

Date: 2026-09-08

### Fixed

- Standalone updates now retry transient DNS, TCP, TLS transport, and connection-timeout failures while fetching both the release manifest and the versioned binary artifact. Retries are bounded and use exponential backoff.
- Explicit cancellation, invalid HTTPS redirects, permanent HTTP failures, artifact size mismatches, and SHA-256 mismatches still fail immediately without weakening release verification.

## 0.2.9

Date: 2026-09-08

### Added

- Gemini Spark can now present a previously unseen user-bound callback during authorization. The existing Owner consent step displays and registers that exact callback for the currently configured static Client ID before issuing the authorization code; no manual callback edit or restart is required.
- Owner-approved callbacks persist in the private, secret-free `<stateRoot>/oauth-static-redirects.json` store and survive restarts.

### Security

- Automatic registration is limited to exact HTTPS callbacks on `oauth-redirect.googleusercontent.com` whose path matches the bounded Gemini custom-MCP form. Wildcards, lookalike hosts, arbitrary HTTPS callbacks, DCR-client mutation, and persistence before Owner authentication remain rejected.
- A denied, expired, or failed registration never persists the callback or redirects to an unapproved destination.

### Changed

- `slnctrz-mcp` remains the installation default Client ID, but Gemini registration now follows the actual configured Client ID. Fresh setup and upgrades no longer inject one account-specific Gemini callback into `client.env`; callbacks already present there remain untouched.

## 0.2.8

Date: 2026-09-08

### Fixed

- The default `slnctrz-mcp` OAuth client now adds the current Gemini Spark callback in memory during startup whenever an older configured allowlist does not contain it. This closes the first-update bootstrap gap where migration code in the newly installed binary could not run until after the old updater completed.
- Persistent migration now appends the current Gemini callback without removing older Gemini or owner-added callbacks. Custom Client IDs remain fully owner-controlled and are not expanded.

## 0.2.7

Date: 2026-09-08

### Fixed

- Upgrades now provision the default static OAuth client when an older installation has no `client.env` file.
- Upgrade and repeated-setup flows automatically add the Gemini Spark callback when the redirect allowlist is still the untouched legacy Claude-only default. Existing Client IDs and secrets are preserved, and custom redirect allowlists remain unchanged.

## 0.2.6

Date: 2026-09-07

### Fixed

- Retry transient HTTP `429` and `5xx` responses while downloading the verified release manifest. Retries are bounded to seven attempts with capped backoff and remain abortable; permanent client errors and invalid release content still fail immediately.

### Included

- Carries the Gemini Spark OAuth install support introduced in the 0.2.5 candidate: automatic OAuth credentials, configurable Client ID/Secret, and the default Gemini callback alongside Claude.

### Note

- The 0.2.5 candidate was not promoted because GitHub's release CDN returned transient `504` responses for the newly uploaded `manifest.json` during both public clean-install jobs. Version 0.2.6 adds the bounded installer recovery required by that observed public-release path.

## 0.2.5

Date: 2026-09-07

### Added

- Fresh installs now register the Gemini Spark custom-MCP callback alongside Claude's callback for the default static OAuth client. The stable Gemini redirect URI is allowlisted; transaction-specific `state` and PKCE `code_challenge` values are never persisted.
- Add `--client-id` and `--client-secret` to both `install.sh` and `slnctrz-mcp setup`. Client ID still defaults to `slnctrz-mcp`, while an omitted Client Secret is generated automatically and stored in the private `client.env` file.

### Compatibility / behavior notes

- Existing `client.env` credentials and redirect allowlists remain preserved unless the owner explicitly supplies replacement setup arguments. Existing installations can add the Gemini callback by editing `SLNCTRZ_CLIENT_REDIRECT_URIS` and restarting the gateway.
- No managed-state schema change. Claude, dynamic registration, PKCE, Owner approval, and MCP token validation retain their existing behavior.

## 0.2.4

Date: 2026-09-06

### Fixed

- `runtimeIdentity` now honors the `$HOME` environment variable for the invoking user's home directory instead of reading only the passwd entry (`os.userInfo().homedir`). This fixes a regression in 0.2.3 that resolved user-mode install/state roots to the real account home whenever `$HOME` was overridden (for example the CI clean-install acceptance host, which isolates `HOME` per run). The live process identity now prefers `os.homedir()`, while an explicitly provided `currentUser.home` is still honored.

### Note

- The 0.2.3 prerelease was superseded before promotion: release tag `v0.2.3` shipped an incomplete candidate that failed the clean Linux User Install gate. This release (`v0.2.4`) carries the runtime-identity and command-provisioning changes below alongside the `$HOME` fix.

## 0.2.3

Date: 2026-09-06

### Changed

- Align the runtime identity (user/group/PATH) in System installs so the gateway runs as the invoking non-root user (the `SUDO_USER`) instead of a fixed system account. The systemd unit is now templated (`User`/`Group`/`PATH` resolved at setup) and no longer creates a dedicated `slnctrz` account.
- Provision the default command catalog without failing closed: only commands resolvable on the runtime PATH are retained, so a single missing binary no longer disables `core.exec` entirely.
- Harden System service activation and recovery: preflight verifies the runtime account can read and write the Initial Path, installation attests the running process identity and release, and failed activation rolls back state/unit.

## 0.2.2

Date: 2026-09-05

### Added

- Auto-provision a static confidential OAuth client on install. Setup now writes `<configRoot>/client.env` with `SLNCTRZ_CLIENT_ID=slnctrz-mcp` and a randomly generated `SLNCTRZ_CLIENT_SECRET`, returning the secret once on first setup. The file is mode-0600 and is **preserved** across reinstall/update (operators may edit it and restart the gateway). `config show` now surfaces `staticClientId` and `staticClientFile`.
- Add `docs/USER_GUIDE.md` — an end-user guide for the Owner Console: adding workspace Paths, adding/discovering MCP servers, and the virtual Provider-ID (prefix ảo) best practice to avoid leaking real path/URL/server names. See `MCP_PROVIDER_STANDARD.md`.

### Compatibility / behavior notes

- No state-schema or runtime-behavior change. A fresh install now always exposes a static confidential client (`client_secret_basic` / `client_secret_post`), the auth required for clients that do not do dynamic registration + PKCE.
- The launcher and Windows installed-runtime path now also load `<configRoot>/client.env` so the static client works in both user and system installation modes.

## 0.2.1

Date: 2026-09-05

### Added

- Expand the default Linux command allowlist (`config/commands.json`) with `gh`, `pip`, and `ssh`, matching the broader permissive set already configured on the production `.227` gateway. A fresh standalone install now seeds these commands instead of the previously narrower default set.

### Compatibility / behavior notes

- No state-schema or runtime-behavior change; the command allowlist default only affects fresh installs.

## 0.2.0 — Agent Guidance + Managed Tasks

Date: 2026-09-05

### Added

- Canonical Product Agent Harness sourced from `AGENTS.md`, delivered through MCP server guidance and exposed through `core.ping.structuredContent.agentHarness`.
- Managed Task Runner with `task.start`, `task.get`, `task.wait`, and `task.cancel`.
- Logical multi-client Task Coordinator with `task.create`, `task.list`, `task.claim`, `task.release`, `task.complete`, and `task.fail`.
- Workspace-scoped coordination with deterministic single-winner task claims across independent authenticated MCP clients.
- Linux and Windows descendant-process-tree cancellation regression coverage for managed tasks.
- Model guidance documenting Runner vs Coordinator semantics and the current in-memory task-lifecycle boundary.

### Compatibility / behavior notes

- Existing `core.exec` behavior and policy authorization remain authoritative; Task Runner reuses the same execution security path.
- Runner tasks are creator-private and workspace-bound.
- Coordination task text is context only and cannot grant filesystem/process/network authority.
- Task Runtime state is intentionally in-memory in this release and does not survive a gateway restart.
- No lease/heartbeat, dependency DAG, resource locks, persistent task storage, or MCP Tasks extension is claimed in 0.2.0.
- Windows System Install/service mode remains unsupported.

## 0.1.1 — First Release SlncTrZ - MCP

Date: 2026-09-04

First public release snapshot of the SlncTrZ - MCP product. Includes the standalone runtime, Owner Console, extension tool identity/namespacing, release/distribution harness, and Windows x64 build support.

- Single cleaned history snapshot tagged as the project's first release.
- Extension tool dispatch namespace-aware (canonical `provider.tool` vs provider-local bare names).
- Standalone installer with immutable version activation and Windows-aware path handling.
- Owner Console with restricted/autonomous modes and MCP provider management.
