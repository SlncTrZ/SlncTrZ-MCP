# QA/QC — SlncTrZ-MCP v0.4.1

Status: LOCAL TECHNICAL QA REAPPROVED — fresh hosted/public release gates pending.

Reviewed at: 2026-10-08T06:37:33Z. Worker-fix baseline: 358d14f77b680d2211eb57c1a0f2daf516989b33.
Baseline: 554ba3c1014b54203a41c314eb13f3814c3bd6ef.
Candidate: v0.4.1; existing v0.4.0 tag remains unchanged.
Reviewer / QA approval: MeiLin (AI), under the owner's explicit conditional release instruction.
This is a technical QA sign-off, not independent human signing-custody certification,
a cryptographic Git signature or the publisher's Ed25519 manifest signature.

## Review Scope

Windows uninstall helper startup/deletion/retention, OAuth migration fixture semantics,
dependency lock patch, private benchmark state, docs contracts/navigation, embedded Model Guide
and version/release consistency. Existing owner diagnostic files remain outside the release changeset.

Hosted Windows uninstall was reproduced and corrected in the worker. Final local QA passed;
fresh exact-commit hosted CI remains required before tagging.

## Final Local Matrix

All rows use package 0.4.1 and the reviewed source.

| Environment          | Full test result                                          | Static/docs/build | Native SEA                                                         |
| -------------------- | --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Linux Node 22.23.3   | 100 files passed, 1 skipped; 739 tests passed, 10 skipped | PASS              | Native packaging uses Node 24                                      |
| Linux Node 24.19.0   | 100 files passed, 1 skipped; 739 tests passed, 10 skipped | PASS              | Build, gateway/OAuth/harness smoke, identity PASS; uninstall 27/27 |
| Windows Node 24.21.0 | 100 files passed, 1 skipped; 724 tests passed, 25 skipped | PASS              | Build, gateway/OAuth/harness smoke, identity PASS; uninstall 36/36 |

Full check includes typecheck, lint, repository format and the complete Vitest suite.
Skips are explicit platform/systemd/symlink and optional image-input exclusions, not failed
assertions disabled for this release. Earlier optional image conformance evidence is recorded
in [v0.4.0 follow-up QA](QA_QC_REPORT_v0.4.0.md); it was not rerun for this patch.

Two initial concurrent Linux runs timed out at the unchanged 5-second Owner Console test.
The targeted test passed in 1.429 seconds, then both full Linux suites passed when run
sequentially. This is consistent with gateway resource contention; no timeout/assertion
change was made to hide the failure. Hosted isolated CI remains required.

Full npm registry audit at 2026-10-08T06:37Z: 0 vulnerabilities, including dev/build.
Lock-derived inventory: 209 packages, 0 UNKNOWN licenses. Reviewed license counts:
MIT 162, Apache-2.0 15, BSD-2-Clause 6, BSD-3-Clause 5, ISC 8, MPL-2.0 12,
BlueOak-1.0.0 1. No new runtime dependency was introduced by this patch.

## Benchmark Regression

The actual source benchmark passed success, invalid-argument and output-write-failure cases
on all three environments. Each checked a caller-state sentinel remained unchanged and
the private temporary-state parent contained no leftovers. RSS failure handling also stops
and waits for the owned child before removing private state.

Harness benchmark passed the 128-skill fixture on every environment. Linux Node 24 cold-start
baseline (5 measured samples, 1 warmup): CLI p50 567.48 ms / p95 608.22 ms; gateway readiness
p50 777.89 ms / p95 788.63 ms. Authenticated MCP protocol ping p95 8.34 ms / p99 14.14 ms.
These are local observations, not SLOs or tool-dispatch measurements.

## Local Artifact Fingerprints

Disposable in-memory verification keys and example.invalid release URLs were used.
Build marker: 358d14f-v041-cmdlet-fix-local. These bytes are not the official public candidate.

| Artifact                    | Size bytes | SHA-256                                                          |
| --------------------------- | ---------: | ---------------------------------------------------------------- |
| Linux x64                   |  127995072 | 2dbdf1932d2829e0721e599d323c4c887c9f64b37da774ce1e953050b9f71f63 |
| Windows x64                 |   95643136 | 7d3210efdf4f9d105f4f3cfbfa63e23e625e409a33190e9449cb77536d8dd723 |
| Embedded Model Guide source |          — | a4187d90b4c56cff952a79d68dbc7184c72f448a4f18b2362f0f47af5204f496 |

## QA Decision & Release Gates

REAPPROVED by MeiLin (AI) after the full worker-fix local matrix passed on all three environments.
Approved to commit and submit the correction to fresh hosted CI; tag/promotion remain conditional.
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

Source commit: 358d14f77b680d2211eb57c1a0f2daf516989b33, pushed to main.
Hosted [CI 37733745830](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37733745830)
passed source tests/static checks, Linux native, license and benchmark gates, but Windows native
uninstall failed: normal/default retained executable, launcher and current.json after the wait.
No release tag was pushed and no candidate was published. Local QA approval does not waive
this mandatory failure. Hosted helper-phase diagnosis ran on a separate disposable branch; the selected fix is below.
The running gateway remains v0.3.7/build 141a26ab43d7eda357ff2ab6ef1114641650853f;
deployment is a separate action.

## Hosted Worker Correction

The [paired probe](https://github.com/SlncTrZ/SlncTrZ-MCP/actions/runs/37737457734)
passed normal/default uninstall with the original CMD launcher plus direct .NET worker APIs
in 3.753 seconds. The native-breakaway comparison also passed, but added 36.407 seconds;
that backend is not adopted. No CIM, native compilation or new process-launch backend is
added to the product. Exact cmdlet/module internals were not independently instrumented;
the observed stall disappears when cmdlet waits/sleeps/deletion are removed.

The product fix pins the live parent process handle before READY, bounds its exit wait,
uses .NET filesystem operations, clears readonly bits only in removal targets and does not
traverse directory reparse points. Native smoke adds a readonly managed-file retention row.
Final worker-fix source matrix passed Linux Node 22/24 and Windows Node 24, with the same
739/724 pass counts and explicit skips above. Native SEA rebuild/smoke/identity passed;
Windows uninstall expanded to 36/36 and Linux remained 27/27. Benchmark isolation cases
passed again on all three environments. No assertion or runtime wait was relaxed to hide
this failure. Fresh hosted CI and public release gates remain pending.
