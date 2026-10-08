# Development Roadmap

Priorities for the v0.4.1 source line. [Project Status](docs/PROJECT_STATUS.md) separates source
implementation, local verification, public release and deployed runtime.

## 1. Current Checkpoint (v0.4.1 source)

- Owner-controlled Linux/Windows gateway, OAuth PKCE, Owner Console, Paths and Commands.
- Full and Gateway-only profiles; first-consent selection and durable Gateway-only grants.
- Structured onboarding through the canonical Product Agent Harness and progressive skills.
- In-memory Runner and Task Coordinator multi-client claim; durable two-participant Debate.
- Usage charts based on gateway-observed numeric telemetry.
- Native Linux/Windows SEA packaging, signed-manifest release workflow and public acceptance gates.
- Durable lifecycle ledger foundation with sanitization and identity checks; controller wiring is pending.

Local QA passes do not establish an exact-candidate stable release. The existing v0.4.0 tag
does not contain the working-tree fixes; the failed hosted runs need fresh candidate evidence.

## 2. Immediate Release Work

1. Review and commit the verified fixes/docs, then obtain Linux Node 22/24 and Windows Node 24 CI evidence.
2. Select a release-candidate version/ref that includes the fixes; preserve immutable published tags.
3. Build native artifacts from that exact ref, aggregate/sign the canonical manifest through the protected environment.
4. Pass public Windows/Linux clean User Install and installed Usage browser acceptance before promotion.
5. Record deployed version/build and real-client acceptance separately; source changes do not upgrade a running gateway.

## 3. Next Objectives

| Priority | Work | Acceptance |
| --- | --- | --- |
| Reliability | Wire the lifecycle ledger into an explicitly owned execution controller | Restart reconciliation, process identity, ownership-safe stop and no credential persistence |
| Latency | Measure provider dispatch before optimizing it | Reproducible p50/p95/p99 under stated load; no inferred speedup |
| Scalability | Bound concurrent provider/context/task work | Limits, cancellation and exhaustion tests; no horizontal multi-process claim |
| Observability | Improve operational visibility | Numeric telemetry, privacy boundaries and installed browser evidence |
| Provider expansion | Integrate additional domain engines | Runtime discovery and each provider's native acceptance |
