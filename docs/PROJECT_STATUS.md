# Project Status

Snapshot: 2026-10-08, Asia/Saigon. This is dated evidence, not a live status endpoint.
Use runtime core.ping and the published GitHub release when making operational decisions.

## Source, Release & Runtime Identity

| Layer                        | Observed state                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Source package               | 0.4.2 release preparation on main; Windows probe and CI verification-key branches merged                                              |
| Working checkout             | Result delivery upgrade and release preparation; two untracked owner diagnostic files preserved                                       |
| Latest public stable release | [v0.4.1](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.4.1); published 2026-10-08 13:51 (+07), draft=false, prerelease=false |
| Running gateway              | core.ping: 0.3.7, build 141a26ab43d7eda357ff2ab6ef1114641650853f                                                                      |
| Prior v0.4.1 CI              | [37738890530](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37738890530): SUCCESS, all five jobs                                |
| Prior v0.4.1 release         | [37739304058](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37739304058): SUCCESS, all thirteen jobs                            |

Current gateway-side source path: `/mnt/pc-dev/SlncTrZ/SlncTrZ-MCP`.
Release commands must use the current native repo path, never a hard-coded workstation mount.
Earlier OAuth migration timeout and Windows uninstall failures remain historical evidence;
the worker correction and fresh exact-commit CI supersede their release-blocking status.

The v0.5.0 candidate passed source, native build/signing and clean Linux/Windows installs,
but its installed Usage browser gate failed while starting Chrome. It was not promoted
stable. The owner selected v0.4.2; v0.5.0 history remains unchanged.

## v0.4.2 Release Preparation

- Per-connection StructuredContent / FullContent preferences persist through refresh/restart.
- All tool registrations use the same delivery formatter; FullContent appends complete JSON text while preserving media and metadata.
- Connection mode and content save immediately; rename saves on Enter. Feedback follows backend confirmation.
- Source and browser verification passed before release preparation. The new tag must pass native build, signing and exact installed-target acceptance before stable promotion.
- Latest-public and running-gateway rows above record the observed baseline; preparing v0.4.2 does not upgrade the running gateway.

## Implemented Source Contract

| Area                         | Current behavior / boundary                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Gateway-only                 | First-consent immutable ceiling; new durable grants with rotating refresh; existing migrated grants remain finite |
| OAuth migration              | Schema v1/v2 to v3; pre-v3 rollback requires coherent pre-migration backup                                        |
| Context/skills               | Four-hour revision-bound receipts; only code-review/debug-and-test seed by default                                |
| Additional repository skills | Explicit project discovery or owner installation; not all embedded in SEA                                         |
| Runner / Coordinator         | In-memory, creator-private Runner and workspace-visible logical tasks                                             |
| Debate                       | Durable two-participant SQLite coordination                                                                       |
| Usage                        | Numeric gateway estimates; no billing/platform-allowance claim                                                    |
| Providers                    | Optional supervised STDIO or remote HTTP; runtime catalog/readiness is authoritative                              |
| Lifecycle ledger             | Durable foundation only; not wired into the gateway or CAD controllers                                            |
| Windows uninstall            | Absolute system helper paths, bounded ready/go startup; deletion deferred after parent exit                       |
| Supply chain                 | Ed25519 manifest signature plus artifact hash; no Windows Authenticode claim                                      |

## Verification Evidence

Final local v0.4.1 QA is approved: Linux Node 22.23.3/24.19.0 each passed 739 tests
with 10 explicit skips; Windows Node 24.21.0 passed 724 with 25 skips. Full static/docs/build
gates passed. Native SEA smoke/identity and uninstall passed Linux 27/27 and Windows 36/36.
The full dependency audit found zero vulnerabilities; inventory contains 209 packages,
no UNKNOWN licenses. Direct benchmark success/failure isolation/cleanup passed all three hosts.

[Current QA report](../QA_QC_REPORT_v0.4.1.md) preserves local fingerprints and earlier failures.
The cmdlet-free pinned-parent worker correction is committed in 29419d6398d5b88ea6050fb404680dab8d416a5f.
Fresh [CI](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37738890530) passed Node 22/24 source gates, Windows native security/runtime,
license inventory and Linux performance baseline. The [release workflow](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37739304058)
passed native builds/identity, multi-target aggregation, candidate publication, clean public
Linux/Windows User Install, installed `/usage` browser acceptance and stable promotion.
The stable release includes both native binaries, installer, manifest/signature and checksums.
Local disposable-key artifacts in the QA report remain separate from published release bytes.

## Documentation Scope

Current guides are reconciled against source contracts, managed-state paths, CLI/help,
embedded assets, package/lockfile and CI/release workflow. ADR current-contract notes
identify OAuth-v3 behavior; historical decisions/releases retain their original evidence.
Repository skills are catalogued separately from installed defaults. Local links and anchors
are checked by docs:check, including skill documentation.

The [documentation index](README.md) provides task-oriented navigation; [Engineering](../ENGINEERING.md)
defines source/native verification, and [Release Acceptance](RELEASE_ACCEPTANCE.md) defines public gates.

## Remaining Operational Work

1. Upgrade the live gateway separately, with coherent state/config backup and post-restart identity checks.
2. Verify named real-client compatibility and disposable-systemd-host acceptance where claimed.
3. Record independent signing custody separately; successful protected publication does not certify it.
4. Preserve or separately review the two untracked Windows diagnostic files.

Public v0.4.1 release gates are complete. Gateway deployment remains separate and is not
claimed by source tests or successful publication. No full test rerun was performed for this
documentation status reconciliation; hosted results above are the current exact-commit evidence.
