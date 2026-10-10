# Project Status

Snapshot: 2026-10-10, accumulating changes for a deferred v0.4.5 release. This is dated maintainer evidence, not a live installation status. Check `--build-info`, `status --json`, runtime `core.ping` and the published release before operational decisions.

## Source, release and runtime

- Package version is 0.4.5 in preparation; [release notes](releases/v0.4.5.md) describe cancellation fixes and provider metadata/drawer improvements. Publication is deliberately deferred while further fixes accumulate; no tag, release or deployment is authorized by this checkpoint.
- Latest implementation checkpoint `919dc646dd09b16d6d2a1e8270066eb7a1798ee2` passed [CI 38030182379](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38030182379). Version/docs preparation `8743d8c6fbc18fe917af79789a848b11aa40f001` passed [CI 38025543845](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38025543845); cancellation fix `4b9a6b6` passed [CI 38024534915](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38024534915). These include Linux Node 22/24, Windows native security/runtime, license and performance gates. Later commits require their own exact-ref CI.
- Latest stable observed on 2026-10-10 was [v0.4.4](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.4.4), release commit `19d7a3452216216f8c0e65e51f609547d4cf3af0`. [Release run 38023563881](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38023563881) passed native builds/identity, protected signing, public Linux/Windows User Install, Chromium acceptance and promotion.
- v0.4.5 must pass those gates on its own signed candidate. Existing published tags/assets remain unchanged.
- Live Gateway-only reachability was checked; exact running build identity was not established by that probe. Source/release operations do not update or restart the live gateway.

## Completed source work

- Linux/Windows account home/config resolution, native Windows folder discovery and systemd provider credential-reference resolution.
- Owner session/navigation preservation and guarded provider actions.
- Unified compact dashboard, offline MeiLin artwork, workspace display name, provider drawer, navigation animation and full-page Orb.
- Gateway-only bootstrap/receipt exemption with Full guards and authorization ceilings preserved.
- Preference-read failures no longer block dashboard loading; provider switches immediately clear stale details.
- Retired introduction media/source bundle removed; branches and task worktrees cleaned after integration.
- Provider handshake name/software version, negotiated protocol and observation time captured for HTTP/STDIO; authenticated details read the newest captured observation without probing or substituting manifest versions.
- Local command show/hide disclosure, accepted Tools total and flexible tool-list height. Arguments/environment remain excluded; contract/schema metadata is not inferred.

## v0.4.3 historical source checkpoint

On the historical product baseline `03c8bc1d1c1d7d8b0e87535961b3e31171895acb`, Windows quality passed 846 tests with 29 explicit skips; Linux quality and developer build passed. Focused recovery regressions passed 59/59. Dashboard browser acceptance passed 79/79 on Linux source, Windows source and Windows native builds; Windows native session/navigation passed 39/39. Native/source dashboard HTML identity matched.

Local native artifacts used disposable verification keys and a preview build marker. They are development evidence, not official release assets. The signed workflow must rebuild and verify the exact release commit. Historical v0.4.1 evidence remains in [QA report](../QA_QC_REPORT_v0.4.1.md); earlier checkpoint details remain in Git history.

### Release preparation CI

The version/docs-only preparation commit `444edb3627bbe2d13aef7e0ce5d88e24eb215cab` passed Linux Node 22/24, license inventory and benchmark gates. Its Windows job passed 845 tests with 29 skips but timed out during minimal-environment AppData lookup. [Run 38019276911](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38019276911) records the failure. Fresh [CI 38019500045](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38019500045) passed all jobs on `6df67949bb303ae800e2e17ddcbea199bb9a640d`, which is the immutable v0.4.3 release commit. No test assertion or product deadline was relaxed.

## Remaining field acceptance

1. Install the published release on live with coherent state/config backup and post-restart identity checks.
2. Record named real-client OAuth/Gateway-only consent, discovery, refresh, reconnect and revoke.
3. Verify live service/keyring credentials; use a disposable host for destructive service/uninstall fixtures.
4. Record independent signing-custody evidence where such a claim is made.

Windows System Install/service remains unsupported. Hosted clean User Install does not certify live service/keyring or named clients. Release and deployment remain separate operations.

## v0.4.3 public candidate checkpoint

[Original release run 38019726916](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38019726916) passed quality, both native builds/identities, protected manifest signing, candidate publication and both clean public User Installs. Installed Chromium acceptance failed before browser startup because the external test harness lacked its `spawn` import. Stable promotion was skipped.

The corrected harness and pinned public-acceptance recovery workflow are committed separately from the immutable release tag. The recovery verifies the original successful gates and unchanged six-asset digests, reruns both public installs and Chromium against the signed candidate, then promotes only after all pass. Product bytes and signing protection remain unchanged; see [release procedure](../RELEASE.md#v043-acceptance-harness-recovery).

## v0.4.3 historical stable completion

[v0.4.3](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.4.3) became the public latest stable release at that checkpoint (not draft/prerelease). [Recovery run 38020258200](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38020258200) passed candidate integrity, clean public Linux/Windows User Install, installed Chromium Usage acceptance and stable promotion. All six public asset digests are unchanged from signed candidate publication.

Chromium verified Owner sign-in, non-empty tool/context savings, all four ranges and custom price calculation against the installed public binary. This does not claim named-client OAuth or live service/keyring acceptance. The production gateway has not been upgraded or restarted by this release operation.

## v0.4.4 historical preparation

Pi's Prediction Seam source commit `b5c4bd7878774134a13f1178381552608c2af136` is on main. Local service inspection found a factory-integration Node entrypoint while installed current.json identified signed v0.4.3; runtime core.ping remained v0.4.2/build unknown.

Four new regressions reproduced unbounded recording/resolution and missing outcome resolution for thrown provider timeout/cancellation. The focused Windows suite passed 17/17 after bounded, cancellable recording and finally-based resolution. Native Windows full source quality passed 862 tests with 29 skips plus typecheck/lint/format, docs and developer build. Release quality/public installation gates and live launcher cutover remain pending at this preparation checkpoint. Required CA and the seam flag will be retained; no credential rotation is requested.

The first v0.4.4 preparation [CI 38022927488](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38022927488) passed Linux Node 22/24, license and performance gates but hit the existing Windows minimal-environment folder-lookup timeout (861 pass, 29 skip, one failure). Windows native process/ACL fixtures are now serialized to remove cross-file contention. Product lookup/request deadlines, test assertions and the test timeout remain unchanged; final CI must verify this ref before tagging.

## v0.4.5 cancellation fix

Review of v0.4.4 reproduced shared CyberBrain recovery caused by the learning deadline and incorrect contradicted assessments for pre-dispatch/queued cancellation. Fix `4b9a6b6094e214a849136ec2da43c31532785923` keeps cancellation request-local and preserves its classification without changing genuine fault recovery or product deadlines.

Before the fix, three supervisor regression assertions failed. Afterward, 43 focused tests passed; Windows Node 24.18.0 full quality passed 867 tests with 29 skips (109 files passed, one skipped), plus typecheck/lint/format, docs and developer build. Tests use the real supervisor for both learning deadlines and pre-dispatch MCP outcome classification. Hosted fix CI passed all five jobs.

Keep the seam disabled on v0.4.4 when avoiding the known restart defect. Updating the source version to v0.4.5 does not repair installed v0.4.4 bytes. The eventual release candidate still needs exact-ref CI, native identity, protected signing, public installs and installed-artifact Chromium acceptance; deployment remains separate.

## v0.4.5 provider metadata and drawer checkpoint

Implementation `919dc646dd09b16d6d2a1e8270066eb7a1798ee2` adds provider-reported handshake identity, protocol and observation time to the detail API/drawer, Local command disclosure, accepted tool total and a flexible list using available panel height. Metadata and successful-probe caches are process-local and can be stale; missing fields stay unknown. Reading details does not invoke providers. Command argv/env remain excluded, and no implicit help call infers contract/schema versions.

Local Windows Node 24 quality passed 871 tests with 29 skips (110 files passed, one skipped), plus typecheck/lint/format, docs and developer build. Headless Chromium using source Owner HTML and isolated API fixtures passed 83/83 checks, including version/count display, Local command reveal and removal of the 320px list cap. This is source UI evidence, not installed v0.4.5 or live-provider acceptance. Hosted CI on that exact implementation commit passed.

No v0.4.5 tag or signed assets have been published and no live gateway was deployed by this work. Keep accumulating fixes until the owner explicitly requests the official release.
