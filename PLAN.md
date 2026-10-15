# Product Plan

Published baseline: v0.4.7 promoted Latest on 2026-10-15. [Project Status](docs/PROJECT_STATUS.md)
separates source, public release and running identity.

## 1. Current product

- Owner-controlled Linux/Windows gateway, OAuth PKCE, Owner Console, Paths and Commands.
- Full and Gateway-only profiles; first-consent selection and durable Gateway-only grants.
- Owner-issued Host Tokens (ADR-030) with 256-bit entropy, 15-day inactivity deletion, and hard-coded Gateway-only ceiling.
- Dynamic Client Registry Hot Reload (A4) and Provider Credential Health (A5).
- Meta-refresh document consent completion with restrictive CSP for Chromium redirect compatibility.
- Gateway-only provider calls need no gateway context receipt; Full guards remain enforced.
- Unified dashboard, provider detail drawer, guarded actions and durable workspace display name.
- Structured onboarding through the canonical Product Agent Harness and progressive skills.
- In-memory Runner and Task Coordinator multi-client claim; durable two-participant Debate.
- Usage charts based on gateway-observed numeric telemetry.
- Native Linux/Windows SEA packaging, signed manifests and public acceptance gates.
- Optional owner-opt-in Prediction Seam with request-local cancellation isolation.
- Durable lifecycle ledger foundation; controller wiring remains pending.

## 2. v0.4.7 milestones shipped

| Requirement | Status | Acceptance |
| --- | --- | --- |
| Owner-issued Host Tokens (ADR-030) | Shipped in v0.4.7 | Unit, conformance, and native installed OpenCode / Pi verification |
| Client Registry Hot Reload (A4) | Shipped in v0.4.7 | Native Console & loopback CLI candidate validation, active grant preservation |
| Provider Credential Health (A5) | Shipped in v0.4.7 | Authenticated health status, missing vs configured reference detection |
| Meta-refresh OAuth consent completion | Shipped in v0.4.7 | Chromium form-action redirect chain workaround, CSP verification |
| Linux system service documentation | Shipped in v0.4.7 | Complete systemd `--mode system` and rootless `systemd --user` runbook |
| Multi-target SEA build & Ed25519 signing | Shipped in v0.4.7 | Native Linux/Windows SEA, clean public User Install and browser acceptance |

## 3. Active and later objectives

| Area | Work | Required evidence |
| --- | --- | --- |
| Performance | Host token lastUsedAt throttle & audit prune optimization | Reduced fsync frequency under high-throughput automation |
| Reliability | Explicit lifecycle-controller wiring for operation ledger | Restart reconciliation, identity and ownership-safe stop |
| Testing | Concurrency stress tests for host token revoke vs auth | Multi-process contention and SQLITE_BUSY verification |
| Observability | Live provider heartbeat monitoring | Proactive upstream health probes without blocking request dispatch |
| Platform | Linux ARM64 native target evaluation | Native ARM64 runner, build-sea, and release-gate verification |
| Provider expansion | Integrate domain engineering engines | Runtime discovery and provider-native acceptance |
