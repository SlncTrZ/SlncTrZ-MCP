# Standalone release operations

This document covers the Phase 8 Linux x64 standalone prototype. It does not authorize
release publication and does not claim Windows, macOS, Linux arm64, signing, or
notarization evidence.

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
