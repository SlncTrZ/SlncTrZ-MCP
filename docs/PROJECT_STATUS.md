# Project Status

Snapshot: 2026-10-09, Asia/Saigon; refreshed after commit/push and CI verification. This is dated maintainer evidence, not a live status
endpoint or a description of your installation. Check `--build-info`, `status --json`,
runtime `core.ping` and the published release before making operational decisions.

## Source, Release & Runtime Identity

| Layer                          | Observed state                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Main baseline                  | Package 0.4.2; local/GitHub main `6bb3531cb2c39bb5d63e99589721c5d6fdd6cf92`; clean                                               |
| Public stable                  | [v0.4.2](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.4.2); not draft/prerelease                                       |
| Development review             | Committed/pushed on `feat/v0.4.3-exec-env`; pre-refresh HEAD `2bd6d902b2a1bcfa25699a27dace702c1cb792c0`; package 0.4.2           |
| Maintainer's inspected gateway | `core.ping`: v0.4.2, buildCommit unknown; source edits do not update it                                                          |
| PR #6 / #7                     | OPEN at `97f4a739a86eabbeea8be395fc331aa1703c8e0c` / `b7fb425860d55145d612ccaa6c75b54fdde36692`; not integrated into this review |

[v0.4.2 release notes](releases/v0.4.2.md) describe the published release. The existing
v0.4.2 tag stays immutable. No v0.4.3 version bump, tag, publication or deployment was
performed for these development changes.

## Commit and CI checkpoint

Exec-environment work (`db34294`), Owner session/navigation (`201a4b3`) and foundational
docs (`0cb09db`) are committed and pushed on the review branch. The owner's CONTRIBUTING
and provenance update (`0e85488`) is retained in both branches.

[Hosted CI 37919075803](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37919075803)
passed all five jobs on exact main `6bb3531cb2c39bb5d63e99589721c5d6fdd6cf92`: Linux
Node 22/24 source gates, Windows native security/runtime, dependency license inventory
and Linux performance baseline. The review branch has no hosted run: the workflow
triggers on pushes to main and pull requests targeting main. Main CI does not certify
the integrated v0.4.3 candidate.

CI fixture fixes are committed on both branches. Windows uses two workers and a 15-second
test timeout; Linux keeps default workers and a 5-second timeout. Product assertions,
startup/request deadlines and the dependency lock remain unchanged. Local main-policy
verification passed 745 tests/10 skips on Linux Node 24.19.0 and 730/25 on Windows
Node 24.18.0 with isolated npm 11.16.0; static/docs/build gates also passed. These results
identify the main-policy run, separately from the development reviews below.

PR #6/#7 integration, real-client acceptance and integrated QA remain pending. Release is
on hold; these commits do not change published v0.4.2 or the inspected gateway.

## Published v0.4.2 behavior

- Per-connection StructuredContent / FullContent preferences persist through refresh/restart.
- FullContent appends structured JSON text while retaining existing media/error metadata.
- Connection mode/content save immediately; rename saves on Enter after backend confirmation.
- Full and Gateway-only consent, schema-v3 OAuth, harness/default skills, providers, Debate
  and Usage retain the boundaries below.

## Implemented Source Contract

| Area                         | Behavior / boundary                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Gateway-only                 | First-consent ceiling; new durable grants with rotating refresh; migrated grants remain finite |
| OAuth migration              | Schema v1/v2 to v3; pre-v3 rollback requires coherent pre-migration backup                     |
| Context/skills               | Four-hour revision-bound receipts; code-review/debug-and-test seed by default                  |
| Additional repository skills | Explicit project discovery or owner installation; not all embedded in SEA                      |
| Runner / Coordinator         | In-memory; creator-private Runner and workspace-visible logical tasks                          |
| Debate                       | Durable two-participant SQLite coordination                                                    |
| Usage                        | Numeric gateway estimates; not platform usage or billing                                       |
| Providers                    | Optional supervised STDIO or remote HTTP; runtime catalog/readiness is authoritative           |
| Lifecycle ledger             | Foundation only; not wired into the gateway or CAD controllers                                 |
| Windows uninstall            | Bounded ready/go helper; deletion deferred after parent exit                                   |
| Supply chain                 | Ed25519 manifest signature plus artifact hash; no Windows Authenticode claim                   |

## Unreleased development verification

WP-00-E exec-environment review and WP-05 session/navigation review passed isolated Linux
and Windows checks. The pre-commit WP-05 product-source suite passed 781 tests/10 skips on Linux
Node 24.19.0 and 766/25 on Windows Node 24.18.0. WP-05 source and native browser matrices
each passed 39 scenarios per OS; native HTML matched the source, and smoke/identity/uninstall
checks passed. Those were disposable local builds, not published v0.4.2 bytes.

WP-01 reconciles user docs, installer syntax and client help. It does not rerun installation,
authenticate named clients, or certify production cookie/OAuth behavior. Client verification
levels are in [Coding Agents](CODING_AGENTS.md#client-evidence-matrix).
WP-04/06/07 UI changes and PR integration remain planned work; final docs/screenshots and
integrated acceptance follow the resulting candidate.

## Historical v0.4.1 evidence

The following retained record describes v0.4.1. It was not rerun during WP-01 and does not
identify today's source/release/runtime.

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

The prior v0.5.0 candidate failed its installed Usage browser startup gate and was not
promoted stable; that history is preserved. v0.4.2 is the observed published baseline.

## Remaining work

1. Review PR integration and finish the planned product packages before integrated acceptance.
2. Finish UI-specific docs/screenshots against the resulting candidate.
3. Record named real-client consent, discovery, refresh/reconnect and revoke results.
4. Obtain disposable-systemd-host and independent signing-custody evidence where claimed.
5. Treat deployment as a separate operation with coherent backup and post-restart identity.

Public release, a working-tree verification and a running gateway are separate facts.
