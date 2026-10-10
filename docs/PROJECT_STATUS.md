# Project Status

Snapshot: 2026-10-10, release preparation. This is dated maintainer evidence, not a live installation status. Check `--build-info`, `status --json`, runtime `core.ping` and the published release before operational decisions.

## Source, release and runtime

- Package version is 0.4.3; [release notes](releases/v0.4.3.md) record the integrated changes.
- All PRs are merged. Product baseline `03c8bc1d1c1d7d8b0e87535961b3e31171895acb` passed [main CI 38018480096](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/38018480096).
- Public stable observed before preparation was [v0.4.2](https://github.com/SlncTrZ/SlncTrZ-MCP/releases/tag/v0.4.2). Existing tags remain unchanged.
- v0.4.3 publication requires protected signing, public Linux/Windows User Install and installed browser acceptance through the [standalone workflow](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/workflows/standalone.yml).
- The inspected live gateway was v0.4.2. Releasing source does not update or restart that process.

## Completed source work

- Linux/Windows account home/config resolution, native Windows folder discovery and systemd provider credential-reference resolution.
- Owner session/navigation preservation and guarded provider actions.
- Unified compact dashboard, offline MeiLin artwork, workspace display name, provider drawer, navigation animation and full-page Orb.
- Gateway-only bootstrap/receipt exemption with Full guards and authorization ceilings preserved.
- Preference-read failures no longer block dashboard loading; provider switches immediately clear stale details.
- Retired introduction media/source bundle removed; branches and task worktrees cleaned after integration.

## Commit and CI checkpoint

On the product baseline above, Windows quality passed 846 tests with 29 explicit skips; Linux quality and developer build passed. Focused recovery regressions passed 59/59. Dashboard browser acceptance passed 79/79 on Linux source, Windows source and Windows native builds; Windows native session/navigation passed 39/39. Native/source dashboard HTML identity matched.

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
