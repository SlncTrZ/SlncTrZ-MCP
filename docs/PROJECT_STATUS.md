# Project Status

Snapshot: 2026-10-08, Asia/Saigon. This is dated evidence, not a live status endpoint.
Use runtime core.ping and the published GitHub release when making operational decisions.

## Source, Release & Runtime Identity

| Layer                        | Observed state                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Source package               | 0.4.1; reviewed main baseline 358d14f77b680d2211eb57c1a0f2daf516989b33                  |
| Follow-up source/docs        | Working-tree patches; not committed or included in the current tag                      |
| Existing v0.4.0 tag          | Points to the baseline, before the uninstall/test/dependency follow-up                  |
| Latest public stable release | [v0.3.7](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.3.7)                    |
| Public v0.4.0 release        | Not found at snapshot time (GitHub release API 404)                                     |
| Running gateway              | core.ping: 0.3.7, build 141a26ab43d7eda357ff2ab6ef1114641650853f                        |
| Main CI baseline             | [37712521964](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37712521964): failure |
| Release baseline             | [37712555541](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37712555541): failure |

The observed failures are OAuth legacy migration test timeout and Windows native uninstall.
Local fixes/checks do not rewrite those hosted results. Source paths moved with the owner's
workspace organization; release commands must use the current native repo path, never a
hard-coded workstation mount.

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

[Current QA report](../QA_QC_REPORT_v0.4.1.md) records fingerprints, initial concurrent Linux
timeouts, sequential reruns and the AI technical approval. Fresh hosted [CI 37733745830](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37733745830)
failed Windows native uninstall although source tests and Linux native passed. A cmdlet-free pinned-parent worker correction passed the full local matrix, including Windows
36/36 native uninstall; fresh hosted CI is pending. No v0.4.1 tag or candidate was published. Protected signing and exact public install/browser gates
remain required after the Windows failure is fixed.

## Documentation Scope

Current guides are reconciled against source contracts, managed-state paths, CLI/help,
embedded assets, package/lockfile and CI/release workflow. ADR current-contract notes
identify OAuth-v3 behavior; historical decisions/releases retain their original evidence.
Repository skills are catalogued separately from installed defaults. Local links and anchors
are checked by docs:check, including skill documentation.

The [documentation index](README.md) provides task-oriented navigation; [Engineering](../ENGINEERING.md)
defines source/native verification, and [Release Acceptance](RELEASE_ACCEPTANCE.md) defines public gates.

## Outstanding Release Gates

1. Review/commit the fixes and refreshed docs, then obtain fresh hosted source-matrix/native results.
2. Select an appropriate immutable candidate ref/version containing those fixes.
3. Build both native targets from the exact ref and complete protected manifest signing/publication.
4. Pass exact public Linux/Windows clean User Install and installed Usage browser acceptance.
5. Verify deployment, real-client compatibility and independent signing custody separately where claimed.

Local disposable-key binaries are not signed public candidates. The owner authorized conditional
release after QA; commit/tag/publication evidence is pending execution. Gateway deployment is separate.
