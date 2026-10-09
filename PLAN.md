# Development Roadmap

Published baseline: v0.4.2 as observed on 2026-10-09. The next product plan is v0.4.3;
it is not a released version. [Project Status](docs/PROJECT_STATUS.md) separates source,
local verification, public release and deployed runtime.

## 1. Current product

- Owner-controlled Linux/Windows gateway, OAuth PKCE, Owner Console, Paths and Commands.
- Full and Gateway-only profiles; first-consent selection and durable Gateway-only grants.
- Structured onboarding through the canonical Product Agent Harness and progressive skills.
- In-memory Runner and Task Coordinator multi-client claim; durable two-participant Debate.
- Usage charts based on gateway-observed numeric telemetry.
- Native Linux/Windows SEA packaging, signed-manifest release workflow and public acceptance gates.
- Durable lifecycle ledger foundation; controller wiring remains pending.

## 2. v0.4.3 work packages

| Package | Goal                                                     | Current review state                                                      |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| WP-00   | Baseline/PR identity and OS-compatible exec environment  | Source integrated; native fix checked on PR; final acceptance pending           |
| WP-01   | User docs, installation/connections and extension guides | Documentation reconciliation; client acceptance and final UI docs pending |
| WP-02   | Shared Dashboard design system/shell                     | Planned                                                                   |
| WP-03   | Read-only provider detail API                            | Planned                                                                   |
| WP-04   | Provider detail drawer/actions/confirmation              | Planned                                                                   |
| WP-05   | Session errors, login flash and navigation               | Verified in isolated review; unreleased                                   |
| WP-06   | Durable workspace display name and greetings             | Planned                                                                   |
| WP-07   | Activity orb/header and accessibility                    | Planned                                                                   |
| WP-08   | Integrated candidate QA, native artifacts and handoff    | Planned after dependencies                                                |

WP-00-E (`db34294`), WP-05 (`201a4b3`), foundational WP-01 docs (`0cb09db`) and
review docs (`bed22b3`) are now merged into main as `5f6854f4fcd60325a793b4fa18d7c1ec951a5bc6`.
PR #6/#7 are also merged; all other local branch tips were already contained in main.
PR #8 now integrates the native Windows folder-discovery fix (`30f6387`) as
`86b0b42cdf1ebd6ca34cd7e078495e4bd0e4464d`. It uses direct .NET Console output instead
of ConvertTo-Json while retaining the 3000-ms lookup bound and environment isolation.
Its exact-head PR CI passed all five jobs, including a second Windows native attempt.
The changes remain unreleased. Check CI on the combined ref separately from earlier
review evidence; final product/client acceptance is still pending. See
[Project Status](docs/PROJECT_STATUS.md#commit-and-ci-checkpoint) for source/release/runtime
boundaries. Release is on hold; preserve the v0.4.2 tag.

## 3. Before release or deployment

1. Complete the authorized packages, integrate the selected patches and review the resulting ref.
2. Check exact candidate source and native builds on supported OS/runtime targets.
3. Reconcile recipes/screenshots with that UI; record client consent/discovery/refresh/revoke evidence.
4. Pass signed-manifest, clean public User Install and installed browser gates before stable promotion.
5. Deploy only as a separate approved operation, with backup and running identity checks.

## 4. Later objectives

| Priority           | Work                                                          | Acceptance                                                                          |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Reliability        | Wire the lifecycle ledger into an explicitly owned controller | Restart reconciliation, identity, ownership-safe stop and no credential persistence |
| Latency            | Measure provider dispatch before optimizing it                | Reproducible p50/p95/p99 under stated load                                          |
| Scalability        | Bound concurrent provider/context/task work                   | Limits/cancellation/exhaustion evidence; no horizontal multi-process claim          |
| Observability      | Improve operational visibility                                | Numeric telemetry, privacy boundaries and installed browser evidence                |
| Provider expansion | Add domain engines                                            | Runtime discovery and each provider's native acceptance                             |
