# Product Plan

Published baseline: v0.4.4 as observed on 2026-10-10. The next patch is v0.4.5 in source
preparation, not yet a published or deployed version. [Project Status](docs/PROJECT_STATUS.md)
separates source, public release and running identity.

## 1. Current product

- Owner-controlled Linux/Windows gateway, OAuth PKCE, Owner Console, Paths and Commands.
- Full and Gateway-only profiles; first-consent selection and durable Gateway-only grants.
- Gateway-only provider calls need no gateway context receipt; Full guards remain enforced.
- Unified dashboard, provider detail drawer, guarded actions and durable workspace display name.
- Structured onboarding through the canonical Product Agent Harness and progressive skills.
- In-memory Runner and Task Coordinator multi-client claim; durable two-participant Debate.
- Usage charts based on gateway-observed numeric telemetry.
- Native Linux/Windows SEA packaging, signed manifests and public acceptance gates.
- Optional owner-opt-in Prediction Seam; v0.4.4 has the cancellation defects described below.
- Durable lifecycle ledger foundation; controller wiring remains pending.

## 2. v0.4.5 patch scope

| Requirement | Status | Acceptance |
| --- | --- | --- |
| Learning deadlines must not restart shared CyberBrain | Source fixed in `4b9a6b6` | Real-supervisor record/resolve deadline tests preserve readiness and unrelated calls |
| Pre-dispatch/queued cancellation must remain indeterminate | Source fixed in `4b9a6b6` | Cancelled error identity and real-supervisor MCP outcome tests |
| Current guides reflect implemented behavior and release boundaries | Version/docs preparation | Docs contract, links, formatting and exact-ref CI |
| Publish exact verified patch artifacts | Pending | Native identity, protected signing, public installs and installed Chromium |

Existing published tags and signed assets remain unchanged. No new database migration,
OAuth grant change, credential rotation or reauthorization is part of this patch.

## 3. Before release or deployment

1. Verify the combined v0.4.5 source ref on Linux Node 22/24 and Windows Node 24.
2. Build and identify native Linux/Windows artifacts from that exact candidate.
3. Pass protected signing, clean public User Install and installed browser gates before stable promotion.
4. Record named-client OAuth and service/keyring evidence separately where those claims are made.
5. Deploy only as a separate approved operation, with coherent backup and running identity checks.

## 4. Later objectives

| Area | Work | Required evidence |
| --- | --- | --- |
| Reliability | Explicit lifecycle-controller wiring | Restart reconciliation, identity and ownership-safe stop |
| Latency | Measure provider dispatch before optimizing | Reproducible p50/p95/p99 under stated load |
| Scalability | Bound concurrent work | Limits/cancellation/exhaustion evidence; no horizontal multi-process claim |
| Observability | Improve operational visibility | Numeric telemetry, privacy boundaries and installed browser checks |
| Provider expansion | Integrate domain engines | Runtime discovery and provider-native acceptance |
