# Release process

This document is the current public-release contract for SlncTrZ-MCP.

The active release line is **0.3.x**. Source history, package version, standalone binary identity, release manifest, and public tag must agree before publication.

## Supported publication target

Current prebuilt targets:

```text
linux-x64
win32-x64
```

Source CI exercises Linux Node 22/24 and Windows Node 24. Windows x64 is a public User Install target in the current 0.3.x line; Windows System Install/service mode is not yet supported. macOS remains outside the public standalone target set.

## Release assets

A multi-target public release contains:

```text
slnctrz-mcp
slnctrz-mcp.exe
manifest.json
manifest.json.sig
SHA256SUMS
install.sh
release notes
```

The standalone binary is a self-contained Node SEA. End-user runtime does not require a source checkout, `node_modules`, or system Node.js.

### Windows signing policy

The 0.3.x Windows distribution tier is allowed to publish an **unsigned** `slnctrz-mcp.exe` at the Authenticode layer. Release notes and troubleshooting must not imply Authenticode signing when it is absent.

The updater's mandatory publisher-authenticity contract is separate: the canonical `manifest.json` is signed with Ed25519, the release publishes `manifest.json.sig`, and every signing-enabled standalone binary embeds the trusted Ed25519 public key. Update/setup manifest retrieval verifies the signature **before** parsing or activating any artifact; the manifest's existing size + SHA-256 fields then bind the exact binary bytes.

If Authenticode is introduced later, signing must occur after SEA injection and before final SHA-256/manifest generation; CI must verify the signature and publish only the signed bytes.

## Build

Use Node 24 on the native target runner. Linux x64 example:

```bash
npm ci
SLNCTRZ_BUILD_COMMIT="$(git rev-parse HEAD)" \
SLNCTRZ_RELEASE_BASE_URL="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/v$(node -p "require('./package.json').version")/" \
SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64="<base64 DER SPKI Ed25519 public key>" \
  npm run build:sea:linux-x64
```

Generated per-target release inputs:

```text
dist/standalone/linux-x64/
├── slnctrz-mcp
├── manifest.json
├── manifest-fragment.json
└── SHA256SUMS

dist/standalone/win32-x64/
├── slnctrz-mcp.exe
├── manifest.json
├── manifest-fragment.json
└── SHA256SUMS
```

The release workflow aggregates both verified fragments into one canonical multi-target `manifest.json` and one release-level `SHA256SUMS`, then signs the exact canonical manifest bytes and emits `manifest.json.sig`.

The bundle, SEA configuration, preparation blob, and signing private key are never release assets.

## Local verification

```bash
npm run docs:check
npm run check
npm run build

cd dist/standalone/linux-x64
sha256sum --check SHA256SUMS
./slnctrz-mcp --help
./slnctrz-mcp --version
./slnctrz-mcp --build-info
cd ../../..

npm run smoke:sea:linux-x64
npm run release:gate -- dist/standalone/linux-x64
```

For an official build, `--build-info` must contain a non-`unknown` commit matching the release commit.

## Version/provenance identity gate

The release gate verifies one identity across:

```text
Git tag = v<package version>
package.json
standalone --version
standalone --build-info
manifest.json version
manifest linux-x64 target
publisher-authentic manifest.json.sig
manifest SHA-256 + size
SHA256SUMS
artifact URL release-tag path
build commit
```

`core.ping` is compiled from the same canonical `APP_VERSION`/`BUILD_COMMIT` constants. Runtime acceptance additionally records `core.ping`/running identity.

Any mismatch blocks promotion.

## GitHub Actions release flow

`.github/workflows/standalone.yml` runs on manual dispatch and `v*` tags.

For a native Windows release workstation, run this before pushing a release tag:

```powershell
npm run release:preflight:windows
```

The preflight fails unless the worktree is clean, the branch is `main`, local HEAD matches
`origin/main`, Node is inside the supported range, GitHub CLI authentication can access this
repository with push permission, and `docs/releases/v<version>.md` exists. On the project hosts,
`/mnt/pc-dev/SlncTrZ-MCP` on the Linux gateway host and `H:\Develop\SlncTrZ-MCP` on the Windows
workstation refer to the same development tree; release commands should still use the native path
for the platform executing them.

### Quality

Node 22 and Node 24:

- locked install;
- `npm run check`;
- `npm run docs:check`;
- developer build;
- production dependency audit.

### Build/verify

Native target builds:

- Linux x64 SEA on `ubuntu-latest`;
- Windows x64 SEA on `windows-latest`;
- exact `github.sha` embedded in each binary;
- the configured Ed25519 release public key embedded in each SEA;
- help/version/build-info smoke;
- target checksum/manifest projection;
- native release identity gate;
- aggregation into one canonical release manifest;
- Ed25519 signing of the exact canonical manifest bytes before publication.

GitHub Actions configuration for an official release:

- repository variable `SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64`: canonical base64 DER/SPKI Ed25519 public key;
- protected GitHub Environment `release-signing` configured **before** the release run;
- Environment secret `SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64`: canonical base64 DER/PKCS8 matching private key;
- `release-signing` deployment policy restricted to selected tags matching `v*`;
- at least one required reviewer, with self-review prevented and administrator bypass disabled for the release environment;
- no repository-level or organization-level duplicate of `SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64` that would bypass the Environment custody boundary.

The workflow itself additionally gates `aggregate-release` to a `v*` tag and checks that the tagged commit is on `origin/main` history before the signing step. A non-tag `workflow_dispatch` may exercise quality/build jobs but must not aggregate, sign, or publish a candidate.

The private key is CI-only and must never be committed, uploaded as an artifact, copied into a runtime install, exposed to an unreviewed workflow ref, or written into release notes/logs. The signing script verifies that the configured public/private keys are a matching Ed25519 pair before writing `manifest.json.sig`. GitHub Environment protection is external repository configuration: the workflow name alone is not proof that reviewer/tag restrictions are actually enabled.

### Candidate publication

On a reviewed `v*` tag only, after the `release-signing` Environment gate and main-history check pass, the workflow creates a **prerelease candidate** containing the verified assets.
The canonical GitHub Release body is `docs/releases/<tag>.md`; candidate publication fails if the
tag-specific notes file is missing. Existing candidates are refreshed with the same notes file, so
generated GitHub notes never replace support, migration, limitation, or rollback statements.

It does not promote immediately.

### Real public redirect + clean User Install acceptance

The release candidate must pass both hosted User Install paths:

```bash
scripts/clean-release-user-e2e.sh "$GITHUB_REF_NAME"
```

and on Windows:

```powershell
./scripts/clean-release-windows-user-e2e.ps1 -Tag $env:GITHUB_REF_NAME
```

Both run against the exact public GitHub Release URL.

For releases that expose `/usage`, promotion also waits for `usage-browser-acceptance`: an Ubuntu runner installs the exact public prerelease candidate, starts the installed gateway, signs into the Owner Console through a real headless Chromium session, opens `/usage`, exercises 24h/7d/30d/all ranges, verifies non-empty tool/savings presentation from numeric-only telemetry fixtures, and verifies custom input-price calculation. The browser job uses no source runtime as the product under test.

This intentionally exercises the real GitHub release-asset redirect class that originally exposed the installer defect.

Acceptance covers:

```text
download public install.sh
download public binary + SHA256SUMS
follow public HTTPS redirects
verify bootstrap SHA-256
run User setup against manifest.json + manifest.json.sig
require publisher signature verification before manifest acceptance
run User setup in isolated HOME
verify installed binary/version/state/passphrase
run status --json
run doctor --json
require no diagnostic FAIL
default uninstall
verify state/config preserved
```

Stable promotion requires clean public User Install acceptance for every advertised target: Linux x64 and Windows x64. When the release contains the Usage dashboard, stable promotion additionally requires the installed-artifact Chromium `/usage` acceptance job. Release-candidate tags remain prerelease evidence and are not promoted to latest.

## System Install release evidence

System Install is implemented for Linux, but a verified end-user System Install claim requires a disposable Linux **systemd** host.

Use only on a clean disposable host:

```bash
sudo SLNCTRZ_E2E_ALLOW_SYSTEM=1 \
  scripts/clean-release-system-e2e.sh vX.Y.Z
```

The script refuses to run when:

- not root;
- there is no validated non-root `SUDO_USER` invoking identity;
- explicit destructive E2E opt-in is absent;
- SlncTrZ managed roots already exist.

It verifies that systemd runs as the real invoking user, state ownership and workspace access match that user, no dedicated service account is required, and health/status/doctor/default-uninstall state preservation all succeed.

Do not run this script on a production gateway.

## Bootstrap

The same `install.sh` supports Linux x64 and Windows x64 Git Bash. Linux example:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "$HOME"
```

`install.sh`:

- requires HTTPS;
- detects `linux-x64` or Git Bash/MSYS `win32-x64`;
- downloads the target binary and `SHA256SUMS`;
- follows HTTPS release redirects;
- requires a strict checksum entry for the detected target;
- verifies SHA-256;
- converts Git Bash `/c/...` paths with `cygpath -w` before invoking the native Windows executable;
- pins setup to the same release URL/manifest used for bootstrap.

Windows Git Bash example:

```bash
sh /tmp/slnctrz-install.sh --mode user --port 3100 --path "$HOME"
```

After setup, the Windows runtime is native `slnctrz-mcp.exe`; Git Bash, Node.js, npm, and the repository are not runtime dependencies.

## Release-signing bootstrap and key lifecycle

The signing-enabled updater pins one Ed25519 public key into each standalone binary. The first release that introduces this mechanism is a **trust bootstrap**: an older installed binary may still acquire that transition release under the historical HTTPS + SHA-256 contract. Once the signing-enabled binary is active, every later setup/update manifest must carry a valid publisher signature or the operation fails before activation.

Planned key rotation is explicit and review-driven. The current schema pins one active key per build; therefore changing the release key is a release-boundary event, not a runtime setting. Before rotating a production key, ship a reviewed transition design that preserves upgrade continuity (for example a multi-key trust set or dual-signature envelope) and test skipped-version clients. Until that transition mechanism ships, **do not rotate the production key casually**.

If the private key is suspected compromised, stop publishing with it. Existing binaries must not be taught to trust an unreviewed replacement key through unsigned metadata. Recovery requires a separately trusted bootstrap/reinstall or a previously shipped rotation mechanism. Revoked private keys are removed from the `release-signing` Environment secret immediately; any accidental repository/organization duplicate is also removed. Public verification keys may remain documented for forensic verification.

## Update/rollback acceptance

Product commands:

```bash
slnctrz-mcp update
slnctrz-mcp rollback
```

Release acceptance for update/rollback requires:

- release A installed;
- persistent Paths/Commands/providers/passphrase configured;
- release B manifest and `manifest.json.sig` downloaded through the public HTTPS/redirect path;
- publisher signature verified before release B artifact download/activation;
- tampered manifest, bad signature, unknown key, and missing signature all fail before activation;
- B activated and, for System Install, restarted/health-checked;
- installed/running identity = B;
- state preserved;
- rollback activates A;
- installed/running identity = A;
- state remains compatible/preserved.

A future state migration must explicitly define rollback compatibility. Never silently roll an incompatible state schema backwards.

## Doctor/repair fault injection

Before broad support, release evidence should include representative faults:

- active binary tamper;
- malformed policy;
- malformed command catalog;
- inaccessible Path;
- Owner Passphrase mode error;
- stopped service;
- provider store/credential error;
- public URL/config error.

`doctor` must identify the failure without mutation/secret leakage.

`repair` is accepted only for its bounded safe actions; it must not erase customer state or silently regenerate credentials.

## Owner Console browser acceptance

A claimed release should test the installed artifact, not a source checkout:

```text
open /owner
login with generated Owner Passphrase
session + CSRF
Overview
Restricted/Autonomous
Path add/remove
Command add/remove
MCP provider add/test/sync/enable/disable/remove
logout/login
```

Local HTTP loopback and claimed public HTTPS modes must both match cookie/security behavior.

## ChatGPT / Claude acceptance

SlncTrZ-MCP implements MCP/OAuth behavior intended for clients including ChatGPT and Claude, but a client is marked **verified for a release** only after a real-client run against the published artifact records:

```text
release version/build
OAuth connect/owner approval
tool discovery
core.ping
read/search
write/edit preview + apply
core.exec per policy
gateway restart/reconnect behavior
MCP provider discovery/invocation
```

Until that evidence exists, docs must describe the connection flow without claiming that client as release-verified.

## Support matrix policy

Maintain separate claims:

### Source/developer

Based on CI for source execution.

### Prebuilt/end-user

Requires all of:

- native artifact;
- public download;
- clean install;
- runtime smoke;
- update/rollback/uninstall evidence appropriate to the mode.

Never convert “tests pass on Windows” into an end-user support claim. Windows x64 end-user support is valid only when the native SEA, public Git Bash bootstrap, installed setup/run/status/doctor/uninstall flow, and clean public Windows acceptance are all green. Hosted update/rollback is a later lifecycle-hardening gate, not a prerequisite for the first Windows User Install release.

## Release notes

Every public release should state:

- version/date;
- user-visible changes;
- security-relevant changes;
- migration/restart/reauthorization impact;
- supported/prebuilt targets;
- known limitations;
- rollback notes.

`CHANGELOG.md` records product history. The canonical public body lives at `docs/releases/v<version>.md` and is enforced by `docs:check`. Changes to the current version's release-note file on `main` are synchronized to an existing GitHub Release by `.github/workflows/release-metadata.yml` using the repository-scoped Actions token. GitHub generated notes may supplement the changelog but do not replace support/known-limitation statements.

## Final release blocking rule

A green unit suite is necessary but not sufficient.

General-user release readiness remains blocked when critical evidence required by the claimed support level is missing. Narrow the support claim rather than silently waiving:

- clean-host evidence;
- public redirect/install evidence;
- systemd evidence for System Install claims;
- browser evidence for Owner Console claims;
- real-client evidence for named client claims.

## v0.3.0 migration

This release adds global coding instructions and progressive Agent Skills. Setup/first start seeds
`<stateRoot>/harness/` once; owner edits remain outside the release directory. Clients must refresh
MCP tool discovery and perform context.bootstrap before ordinary work calls. Context receipts are
in-memory, expire after four hours and must be renewed after restart or instruction/policy changes.
Read [HARNESS.md](docs/HARNESS.md) and [CODING_AGENTS.md](docs/CODING_AGENTS.md) before upgrading
an automated integration. Existing authorization and provider ownership remain unchanged.
