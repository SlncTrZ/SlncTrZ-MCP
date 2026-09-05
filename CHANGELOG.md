# Changelog

User-visible product changes are recorded here. Internal commit history is not a substitute for release notes.

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
