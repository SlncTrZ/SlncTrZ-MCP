# Provenance

This document records source/dependency provenance and license obligations for the current SlncTrZ-MCP release line.

## Project

- **Project:** SlncTrZ-MCP — Universal MCP Gateway
- **Current release line:** 0.2.x
- **License:** Apache-2.0 (`LICENSE`)
- **Implementation:** independent/clean-room project implementation based on project requirements, public MCP protocol specifications, measured behavior, and independently written tests.

Historical research/reference material is kept outside tracked production source.

## Provenance classes

Production design references use:

- **R** — project requirement/living architecture;
- **P** — public protocol specification;
- **D** — architecture decision record;
- **B** — independently observed/measured behavior.

When an external source influences a decision, attribute the idea rather than copying source text.

## Direct runtime dependency inventory

Snapshot from the locked dependency tree for the 0.2.x release line:

| Package                        | Locked version | License | Purpose                           |
| ------------------------------ | -------------: | ------- | --------------------------------- |
| `@modelcontextprotocol/node`   |          2.0.0 | MIT     | Node MCP HTTP/runtime integration |
| `@modelcontextprotocol/server` |          2.0.0 | MIT     | MCP server/protocol primitives    |
| `zod`                          |          4.4.3 | MIT     | Runtime schema validation         |

The `zod` runtime dependency is part of the shipped bundle and must not be omitted from license/provenance review.

## Development/build dependency snapshot

| Package               | Locked version | License    | Purpose                 |
| --------------------- | -------------: | ---------- | ----------------------- |
| `typescript`          |          6.0.3 | Apache-2.0 | compiler/typechecking   |
| `@types/node`         |         26.3.0 | MIT        | Node type definitions   |
| `vitest`              |         4.1.11 | MIT        | unit/conformance tests  |
| `@vitest/coverage-v8` |         4.1.11 | MIT        | coverage                |
| `eslint`              |         10.9.1 | MIT        | lint                    |
| `typescript-eslint`   |         8.68.0 | MIT        | TypeScript lint rules   |
| `prettier`            |          3.9.6 | MIT        | formatting              |
| `esbuild`             |         0.28.2 | MIT        | standalone bundle       |
| `postject`            |  1.0.0-alpha.6 | MIT        | Node SEA blob injection |

Versions above are documentation snapshots. The lockfile + generated CI inventory are authoritative for a particular commit.

## CI license evidence

`.github/workflows/ci.yml` runs `npm run provenance:inventory` to generate a deterministic dependency/license inventory directly from `package-lock.json`, then uploads it as a CI artifact.

Before a public release:

- locked dependencies must be installed;
- production dependency audit must pass according to release policy;
- dependency/license inventory must be reviewed;
- new NOTICE/copyright obligations must be added when required.

A future SPDX/CycloneDX SBOM artifact is preferred when the release process adopts a stable generator.

## Standalone provenance

Official SEA builds embed:

```text
APP_VERSION       <- package.json
BUILD_COMMIT      <- exact CI github.sha / SLNCTRZ_BUILD_COMMIT
```

Release gate verifies:

- tag/version agreement;
- binary `--version`;
- binary `--build-info`;
- manifest version;
- artifact SHA-256/size;
- `SHA256SUMS`;
- exact release-tag asset URL.

`BUILD_COMMIT=unknown` is allowed for local development but blocks the official release identity gate.

## Third-party obligations

When adding a dependency:

1. record purpose and license;
2. review transitive obligations;
3. preserve required notices/attributions;
4. evaluate copyleft or distribution constraints before inclusion;
5. keep credentials/private reference material out of source and release assets.

No dependency license inventory should be inferred from an old documentation table when the lockfile has changed.
