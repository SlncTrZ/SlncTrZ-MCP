# Changelog

User-visible product changes are recorded here. Internal commit history is not a substitute for release notes.

## 0.3.3

Date: 2026-09-22

### Added

- Per-OAuth-grant Tool Surface Profiles with Full and Gateway-only modes, including agent self-restriction and Owner-controlled promotion/restriction.
- Durable private SQLite grant/token storage so grants issued by v0.3.3 survive normal gateway restarts without persisting plaintext bearer or refresh tokens.
- Durable two-participant Debate with exactly six MCP tools, persisted turn/deadline/idempotency state, and connection-bound opaque membership credentials.
- Owner `/debate` live/history UI and authenticated stop/resume/read APIs.
- Owner Console, loopback control-plane, and standalone CLI operations for connection profile management.
- Secret-free provider incident correlation and gateway lifecycle/restart observability.

### Changed

- Gateway-only provider dispatch bypasses only the coding-harness receipt requirement while preserving OAuth, policy, provider, credential, and transport checks.
- Effective Tool Surface Profile is resolved from durable authenticated grant state on every MCP exchange.
- Provider audit events can distinguish invalid-session recovery, startup unavailability, transport/auth/protocol/timeout classes, recovery, and quarantine without retaining provider payloads or credentials.
- Release/update restart paths can persist a short-lived one-shot restart intent so the next startup correlates a known release/control restart.

### Security

- Gateway-only hidden tools are disabled at discovery and fail closed on direct dispatch.
- Agents may reduce their own grant to Gateway-only but cannot self-promote to Full.
- Debate authorization binds membership credential and participant identity to the server-derived authenticated connection.
- OAuth token persistence uses token hashes only; Owner connection views return no token values.
- Provider/lifecycle observability remains metadata-only and does not retain tool arguments, output, endpoint data, environment values, bearer tokens, refresh tokens, or membership credentials.

### Fixed

- Normal gateway restarts no longer invalidate grants issued by v0.3.3.
- OAuth grant profile and Debate membership/state now survive an application restart through the same managed state root.
- SIGTERM/SIGINT shutdown reasons are retained in audit when the gateway can observe them; external SIGKILL/OS termination remains intentionally unattributed.
- Provider recovery keeps the no-auto-replay invariant for the failed call while retaining one correlation ID across recovery/quarantine state.

### Compatibility / known limitation

- Grants created by v0.3.2 were process-local and cannot be migrated retroactively, so the first upgrade to v0.3.3 may require one reconnect/reauthorization.
- Debate V1 supports exactly two participants.
- GPT web and Pi/OpenCode real-client field validation continues after release for this owner-only deployment and is not claimed as completed pre-tag evidence.
- Windows x64 stable publication remains gated by the native Windows build and clean public Windows User Install job in the release workflow.

## 0.3.2

Date: 2026-09-12

### Added

- Provider-local observability counters for invalid Streamable HTTP sessions and successful/failed session recovery, without provider labels, credentials, tool arguments, or result content.
- Regression coverage for repeated stale-session incidents, startup self-recovery, no-replay semantics, and two-provider recovery isolation.

### Changed

- Owner Console sessions now use a 3-hour sliding idle timeout capped by a 12-hour absolute lifetime instead of a fixed 15-minute window.
- `/owner` Overview now focuses on Commands and MCP operational health; runtime/build details move to a collapsed Advanced panel and Usage is presented as a normal control.
- Owner Console panel styling now uses the restrained cyan/violet visual language of the sign-in surface while preserving light/dark and reduced-motion behavior.
- Signing out revokes only the current Owner session, and expired in-memory sessions are pruned during normal authentication activity.

### Fixed

- Streamable HTTP providers now recognize a session-bound legacy `404` as an invalid MCP session, clear stale session state, and recover with a fresh provider-local handshake without requiring Owner Console Sync.
- The supervisor restart budget is now scoped to one recovery incident. A successful recovery no longer consumes a lifetime restart allowance that could quarantine a healthy provider on a later transient fault.
- A provider that is temporarily unavailable during gateway startup now receives bounded background recovery instead of remaining failed until a policy reload.
- Recovery never automatically replays the tool call that observed the failure, preventing duplicate write/execute side effects; callers receive the existing stable `provider_unavailable` result for that failed call and may retry explicitly.

### Compatibility / known limitation

- No managed-state schema migration is required; existing Paths, Commands, providers, credentials, Owner Passphrase, audit history, usage history, and harness state are preserved across update.
- Automatic provider fault recovery is provider-local. Owner-driven provider configuration mutations (`Add`, `Enable/Disable`, `Sync`, credential activation) still activate through a policy/runtime generation reload and may restart other configured providers; generation-local mutation is a future scalability optimization.

## 0.3.1

Date: 2026-09-11

### Added

- Read-only `/usage` dashboard with 24h/7d/30d/retained-history views, per-tool traffic breakdown, progressive Agent Skill context savings, and a custom input-price estimate.
- Separate bounded `<stateRoot>/usage.sqlite3` ledger for numeric/classification usage metadata. It is independent from the security audit journal.
- Passive MCP boundary measurement for exact request/response bytes and versioned model-neutral `utf8-bytes-v1` token estimates.
- ADR-028 defining fail-open usage telemetry, privacy boundaries, and honest savings semantics.

### Changed

- Product positioning now leads with owner-controlled Web AI access to a Linux or Windows machine; coding harness and MCP gateway remain core capabilities rather than the whole product identity.
- Agent Skills may now use `SKILL.md` files up to 256 KiB while retaining the 8 KiB YAML-frontmatter bound, 1 MiB on-demand resource bound, and progressive disclosure.
- README and operator-facing documentation are reorganized for human evaluators and operators: product value and quick start come first, implementation contracts remain linked rather than dominating the entry page.
- Public project status now states the adoption gap directly: engineering maturity is ahead of stars/forks/community coverage, and internal test evidence is not presented as independent security certification.

### Fixed

- Linux User Install launchers now infer the active install root from the launcher's own directory when `SLNCTRZ_INSTALL_ROOT` is not explicitly set, so a user-mode launcher cannot silently fall back to `/opt/slnctrz-mcp` and start a different system installation.
- The v0.3.1 release browser gate now invokes its shell script portably, preserves executable metadata, supplies the generated runtime config, and isolates its control port before testing the installed `/usage` dashboard.

### Security

- Usage telemetry persists no prompts, request bodies, tool arguments, paths, file contents, command output, provider payloads, credentials, bearer tokens, or context receipts.
- Usage observation is non-authoritative and fail-open: estimator, queue, SQLite, or dashboard failures do not authorize, deny, replay, or fail valid MCP work.
- Usage APIs remain behind the existing Owner Console session; the Owner cookie stays scoped to `/owner`, and `/usage` introduces no second credential system.

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
