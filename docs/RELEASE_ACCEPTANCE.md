# Release Acceptance Criteria

This checklist defines required evidence; PASS must identify the exact commit/artifact under
test. Local source checks and disposable-key builds do not certify a stable public release.
See [Release Process](../RELEASE.md) and [Project Status](PROJECT_STATUS.md).

## 1. Source & Native Gates

| Gate          | Required evidence                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Source matrix | Locked install, check/tests, docs check and developer build; Linux Node 22/24 and Windows Node 24                    |
| Dependencies  | Production audit; review full dev/build audit and generated license inventory                                        |
| Native SEA    | Native Linux/Windows build, help/version/build-info, gateway/OAuth/embedded harness smoke                            |
| Identity      | Exact version/ref/build, manifest projection, size/SHA-256 and SHA256SUMS                                            |
| Uninstall     | Native default/remove-config/purge; retained roots, quoted paths, Windows shell PATH/cwd and helper-startup failures |

Current smoke matrices contain 27 Linux and 33 Windows cases. Tests of spawn failure, early
helper exit and missing ready acknowledgement must preserve managed files even under purge.
Confirm deferred Windows deletion completes after process exit; startup acknowledgement alone
is not completion.

## 2. Release Signing & CI Integrity

- The production signing job requires the `release-signing` Environment exists **before** the workflow run.
- Require protected tag policy, independent reviewer/self-review restrictions and no duplicate private-key secrets.
- Verify exact canonical manifest signature and binary size/SHA-256 before accepting assets.
- Non-tag disposable-key CI/local builds are unpublished test evidence, not production trust.
- Never move an immutable published candidate/release tag to include new fixes.

## 3. Public Candidate & Promotion

Stable promotion requires the exact signed public candidate's Linux and Windows clean User
Install acceptance through actual HTTPS redirects. A release exposing Usage additionally
requires installed-artifact Chromium /usage browser acceptance. Version/build/profile, status,
doctor, default-uninstall retention and checksums must identify the same candidate.

Linux System Install requires a separate disposable systemd host. Windows System Install
is unsupported. Named real-client, Owner browser and independent signing-custody claims
need their own evidence; do not infer them from unit tests.

## 4. State Management & Migrations

- Owner authority changes follow OLD -> committed -> active runtime NEW and fail/rollback safely.
- Exercise official legacy + modern-only provider negotiation without replaying failed mutations.
- Concurrent resource claims resolve to exactly one winner.
- OAuth v1/v2 -> v3 migration preserves existing profile/label/token-expiry semantics.
- New Gateway-only grants retain immutable ceilings, rotating refresh and restart/offline durability.
- Pre-v3 rollback requires coherent pre-migration state/config restoration while stopped.

## 5. Managed Task Runtime release acceptance

Verify task.start/get/wait/cancel, task.create/claim/release/complete/fail, ownership isolation,
context.bootstrap and skills.read. Shutdown requests cleanup of owned child runners; forced
kill/host-crash behavior is a separate scenario.

Task/receipt state stays in-memory. The lifecycle ledger is an unwired foundation; ledger
tests do not establish live execution-controller or restart-reconciliation acceptance.

Image validation must separately record authenticated transport, model perception and actual
user display. Gateway image blocks alone do not prove the client rendered an attachment.
