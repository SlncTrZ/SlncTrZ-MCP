# QA/QC — SlncTrZ-MCP v0.4.1

Status: LOCAL TECHNICAL QA APPROVED — hosted/public release gates pending.

Reviewed at: 2026-10-08T05:41:17Z.
Baseline: 554ba3c1014b54203a41c314eb13f3814c3bd6ef.
Candidate: v0.4.1; existing v0.4.0 tag remains unchanged.
Reviewer / QA approval: MeiLin (AI), under the owner's explicit conditional release instruction.
This is a technical QA sign-off, not independent human signing-custody certification,
a cryptographic Git signature or the publisher's Ed25519 manifest signature.

## Review Scope

Windows uninstall helper startup/deletion/retention, OAuth migration fixture semantics,
dependency lock patch, private benchmark state, docs contracts/navigation, embedded Model Guide
and version/release consistency. Existing owner diagnostic files remain outside the release changeset.

No additional concrete product regression was established in the reviewed diff.
Hosted Windows uninstall still requires fresh exact-commit CI evidence.

## Final Local Matrix

All rows use package 0.4.1 and the reviewed source.

| Environment          | Full test result                                          | Static/docs/build | Native SEA                                                         |
| -------------------- | --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Linux Node 22.23.3   | 100 files passed, 1 skipped; 739 tests passed, 10 skipped | PASS              | Native packaging uses Node 24                                      |
| Linux Node 24.19.0   | 100 files passed, 1 skipped; 739 tests passed, 10 skipped | PASS              | Build, gateway/OAuth/harness smoke, identity PASS; uninstall 27/27 |
| Windows Node 24.21.0 | 100 files passed, 1 skipped; 724 tests passed, 25 skipped | PASS              | Build, gateway/OAuth/harness smoke, identity PASS; uninstall 33/33 |

Full check includes typecheck, lint, repository format and the complete Vitest suite.
Skips are explicit platform/systemd/symlink and optional image-input exclusions, not failed
assertions disabled for this release. Earlier optional image conformance evidence is recorded
in [v0.4.0 follow-up QA](QA_QC_REPORT_v0.4.0.md); it was not rerun for this patch.

Two initial concurrent Linux runs timed out at the unchanged 5-second Owner Console test.
The targeted test passed in 1.429 seconds, then both full Linux suites passed when run
sequentially. This is consistent with gateway resource contention; no timeout/assertion
change was made to hide the failure. Hosted isolated CI remains required.

Full npm registry audit at 2026-10-08T05:36:22Z: 0 vulnerabilities, including dev/build.
Lock-derived inventory: 209 packages, 0 UNKNOWN licenses. Reviewed license counts:
MIT 162, Apache-2.0 15, BSD-2-Clause 6, BSD-3-Clause 5, ISC 8, MPL-2.0 12,
BlueOak-1.0.0 1. No new runtime dependency was introduced by this patch.

## Benchmark Regression

The actual source benchmark passed success, invalid-argument and output-write-failure cases
on all three environments. Each checked a caller-state sentinel remained unchanged and
the private temporary-state parent contained no leftovers. RSS failure handling also stops
and waits for the owned child before removing private state.

Harness benchmark passed the 128-skill fixture on every environment. Linux Node 24 cold-start
baseline (5 measured samples, 1 warmup): CLI p50 559.57 ms / p95 568.14 ms; gateway readiness
p50 661.26 ms / p95 714.80 ms. Authenticated MCP protocol ping p95 6.80 ms / p99 11.84 ms.
These are local observations, not SLOs or tool-dispatch measurements.

## Local Artifact Fingerprints

Disposable in-memory verification keys and example.invalid release URLs were used.
Build marker: 554ba3c-v041-review-local. These bytes are not the official public candidate.

| Artifact                    | Size bytes | SHA-256                                                          |
| --------------------------- | ---------: | ---------------------------------------------------------------- |
| Linux x64                   |  127995072 | 2423450e818ea2971bc5f744a5cbb9605bd8a4705b3f8b86b8dd16f3e239ddb3 |
| Windows x64                 |   95642112 | d42f49969c53cb745db28e2ffa79e4437421132096fec574540a75d6e898fd5f |
| Embedded Model Guide source |          — | a4187d90b4c56cff952a79d68dbc7184c72f448a4f18b2362f0f47af5204f496 |

## QA Decision & Release Gates

APPROVED to commit and submit v0.4.1 to the official release workflow.
Stable publication approval remains conditional on fresh exact-commit source/native CI,
protected manifest signing, public Linux/Windows clean User Install and installed Usage
browser acceptance. Any failing mandatory gate blocks promotion.

The native Windows preflight is not reported as PASS: local gh authentication is invalid
and owner diagnostic files make the working checkout unclean. Automated release preflight
uses an isolated clean main checkout, remote-main equality, supported Node, tag notes,
Git SSH transport and authenticated GitHub connector push permission. These are recorded
separately under [Release process](RELEASE.md); signing Environment protection is unchanged.

Independent signing custody, real-client compatibility and disposable systemd-host
acceptance are not certified by this QA record.

## Publication State

Source commit, tag, hosted run and public artifact results will be recorded after execution.
The running gateway remains v0.3.7/build 141a26ab43d7eda357ff2ab6ef1114641650853f;
deployment is a separate action.
