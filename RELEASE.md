# Release process

This document is the current public-release contract for SlncTrZ-MCP.

The active release line is **0.1.x**. Source history, package version, standalone binary identity, release manifest, and public tag must agree before publication.

## Supported publication target

Current prebuilt targets:

```text
linux-x64
win32-x64
```

Source CI exercises Linux Node 22/24 and Windows Node 24. Windows x64 is a public User Install target from 0.1.x; Windows System Install/service mode is not yet supported. macOS remains outside the public standalone target set.

## Release assets

A multi-target public release contains:

```text
slnctrz-mcp
slnctrz-mcp.exe
manifest.json
SHA256SUMS
install.sh
release notes
```

The standalone binary is a self-contained Node SEA. End-user runtime does not require a source checkout, `node_modules`, or system Node.js.

### Windows signing policy

The first 0.1.x Windows distribution tier is allowed to publish an **unsigned** `slnctrz-mcp.exe`. The mandatory trust contract is the official GitHub Release URL plus the release-level SHA-256/manifest verification. Release notes and troubleshooting must not imply Authenticode signing when it is absent.

If Authenticode is introduced later, signing must occur after SEA injection and before final SHA-256/manifest generation; CI must verify the signature and publish only the signed bytes.

## Build

Use Node 24 on the native target runner. Linux x64 example:

```bash
npm ci
SLNCTRZ_BUILD_COMMIT="$(git rev-parse HEAD)" \
SLNCTRZ_RELEASE_BASE_URL="https://github.com/SlncTrZ/SlncTrZ-MCP/releases/download/v$(node -p "require('./package.json').version")/" \
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

The release workflow aggregates both verified fragments into one canonical multi-target `manifest.json` and one release-level `SHA256SUMS`.

The bundle, SEA configuration, and preparation blob are build intermediates, not release assets.

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
manifest SHA-256 + size
SHA256SUMS
artifact URL release-tag path
build commit
```

`core.ping` is compiled from the same canonical `APP_VERSION`/`BUILD_COMMIT` constants. Runtime acceptance additionally records `core.ping`/running identity.

Any mismatch blocks promotion.

## GitHub Actions release flow

`.github/workflows/standalone.yml` runs on manual dispatch and `v*` tags.

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
- help/version/build-info smoke;
- target checksum/manifest projection;
- native release identity gate;
- aggregation into one canonical release manifest before publication.

### Candidate publication

On a tag only, the workflow creates a **prerelease candidate** containing the verified assets.

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

This intentionally exercises the real GitHub release-asset redirect class that originally exposed the installer defect.

Acceptance covers:

```text
download public install.sh
download public binary + SHA256SUMS
follow public HTTPS redirects
verify SHA-256
run User setup in isolated HOME
verify installed binary/version/state/passphrase
run status --json
run doctor --json
require no diagnostic FAIL
default uninstall
verify state/config preserved
```

Stable promotion requires clean public User Install acceptance for every advertised target: Linux x64 and Windows x64. Release-candidate tags remain prerelease evidence and are not promoted to latest.

## System Install release evidence

System Install is implemented for Linux, but a verified end-user System Install claim requires a disposable Linux **systemd** host.

Use only on a clean disposable host:

```bash
sudo SLNCTRZ_E2E_ALLOW_SYSTEM=1 \
  scripts/clean-release-system-e2e.sh vX.Y.Z
```

The script refuses to run when:

- not root;
- explicit destructive E2E opt-in is absent;
- SlncTrZ managed roots already exist.

It verifies dedicated `slnctrz` account/service behavior, health, status/doctor, and default-uninstall state preservation.

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

## Update/rollback acceptance

Product commands:

```bash
slnctrz-mcp update
slnctrz-mcp rollback
```

Release acceptance for update/rollback requires:

- release A installed;
- persistent Paths/Commands/providers/passphrase configured;
- release B downloaded through public manifest/redirect path;
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

`CHANGELOG.md` records product history. GitHub generated notes may supplement it but do not replace support/known-limitation statements.

## Final release blocking rule

A green unit suite is necessary but not sufficient.

General-user release readiness remains blocked when critical evidence required by the claimed support level is missing. Narrow the support claim rather than silently waiving:

- clean-host evidence;
- public redirect/install evidence;
- systemd evidence for System Install claims;
- browser evidence for Owner Console claims;
- real-client evidence for named client claims.
