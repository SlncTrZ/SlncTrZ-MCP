# Standalone release operations

This document covers the Phase 8 Linux x64 standalone prototype and the Phase 9 release CI
gates. It does not authorize release publication and does not claim Windows, macOS,
Linux arm64, signing, or notarization evidence.

## Build

Use Node 24 on Linux x64. The binary used to create the SEA blob must be the same binary
that receives the injection.

```bash
npm ci
SLNCTRZ_RELEASE_BASE_URL=https://downloads.example.test/slnctrz-mcp/ \
  npm run build:sea:linux-x64
```

Generated release inputs:

```text
dist/standalone/linux-x64/
├── slnctrz-mcp
├── manifest.json
└── SHA256SUMS
```

The intermediate bundle, SEA configuration, and preparation blob are build products, not
release assets.

## Verify

```bash
cd dist/standalone/linux-x64
sha256sum --check SHA256SUMS
./slnctrz-mcp --help
./slnctrz-mcp --version
cd ../../..
npm run smoke:sea:linux-x64
```

The smoke script generates an ephemeral verifier in memory, starts the packaged deny-all
gateway on ephemeral ports, waits for both listeners, and terminates it. It does not print
or persist the verifier.

## Install or upgrade

The operator supplies a strict HTTPS manifest and an absolute installation root:

```bash
./slnctrz-mcp install \
  --manifest https://downloads.example.test/slnctrz-mcp/manifest.json \
  --root /opt/slnctrz-mcp
```

Installation streams the selected host artifact to .staging/, verifies its declared size
and SHA-256, writes immutable version metadata, and atomically replaces current.json.
A failed download, size/hash mismatch, or conflicting same-version artifact leaves the
active release unchanged.

There is no background update service. Selecting a manifest and initiating an upgrade are
explicit operator actions.

## Roll back

```bash
./slnctrz-mcp rollback --root /opt/slnctrz-mcp
```

Rollback activates the one recorded previous verified version. It fails closed if
activation or version metadata is missing or corrupt.

## Publication gate

Do not publish unless all intended targets have:

- A native build record.
- Artifact SHA-256 and declared size verification.
- A clean-machine boot/smoke record.
- Required Windows signing or macOS signing/notarization evidence.
- An approved release action.

The standalone workflow uploads and verifies CI artifacts only. It intentionally does not
publish a GitHub Release.

## Phase 9 release gates

### Preflight checklist

Before tagging a `v*` release, confirm on a clean Linux x64 runner:

- [ ] `npm run check` green on Node 22 and Node 24.
- [ ] `npm run build` succeeds.
- [ ] `npm run benchmark` emits a baseline JSON; p50/p95/p99 reviewed against the prior baseline (no unexplained regression).
- [ ] `standalone.yml` quality gate green; `build-linux-x64` SEA builds and `verify` passes (checksum + manifest + binary smoke).
- [ ] `RELEASE.md` and `docs/THREAT_MODEL.md` match the shipped artifact and evidence.
- [ ] Support matrix below matches real evidence (no claimed target without a run).

### CI artifact verification

Two workflows provide the evidence; neither publishes a GitHub Release.

- `ci.yml` runs on `pull_request` / `push` to `master`: typecheck, lint, format:check, and unit tests on Node 22 + 24, plus a `Linux x64 performance baseline` job that builds and records cold-start/readiness/RSS samples to `performance-baseline-linux-x64-node24`.
- `standalone.yml` triggers only on `workflow_dispatch` or `push: tags: v*`. Its `quality` job (Node 22 + 24: `npm run check`, `npm run build`, `npm audit`) gates `build-linux-x64`, which builds the SEA and uploads verified inputs; `verify Linux x64 SEA` downloads the artifact and re-checks checksum, manifest projection, and the binary smoke. Dispatch it manually before a release tag to obtain evidence.

### Benchmark baseline

`npm run benchmark` launches clean child processes from `dist/` with an ephemeral owner verifier and deny-all policy. It records raw samples plus p50/p95/p99 for CLI `--help` cold start, gateway readiness, and (Linux) RSS at readiness. Output is a JSON artifact; it does not impose a failing budget before CI has a stable baseline, so regression is reviewed by comparing the new artifact to the prior one. It contacts no external services.

### Support matrix

| Target                      | Status   | Evidence                                               |
| --------------------------- | -------- | ------------------------------------------------------ |
| Linux x64 standalone        | Verified | Local + `standalone.yml` SEA build/verify (Node 22/24) |
| Linux arm64                 | Pending  | Native build + clean-machine smoke required            |
| Windows x64                 | Pending  | Native build + smoke + signing required                |
| macOS x64                   | Pending  | Native build + smoke + notarization required           |
| macOS arm64                 | Pending  | Native build + smoke + notarization required           |
| Code signing / notarization | Pending  | Platform signing/notarization evidence required        |
| OAuth-to-tool real client   | Pending  | Real-client verification required                      |

Unsupported targets are not claimed. Publication requires an approved release action and the evidence above for every intended target.
