# Engineering Guide

Conventions, tooling, and the supported runtime matrix for SlncTrZ-MCP.

## Supported runtime versions

Source of truth is the `engines` field in `package.json` and the CI matrix.

### Node.js

| Version         | Status                                        |
| --------------- | --------------------------------------------- |
| `>=22.13.0 <25` | **Supported source runtime contract**         |
| `<22.13.0`      | Unsupported                                   |
| `>=25`          | Unsupported until package/CI contract changes |

Current development environment: Node `v24.18.0`, npm `11.16.0`. TypeScript
`6.0.3`, lint with ESLint `10.9.1` and `typescript-eslint`, format with Prettier
`3.9.6`, tests with Vitest `4.1.11`.

### Operating systems (target matrix, PLAN Phase 8)

| OS      | Arch  | Developer/source evidence | Standalone SEA evidence    |
| ------- | ----- | ------------------------- | -------------------------- |
| Linux   | x64   | CI: Node 22 + 24          | Public release target      |
| Linux   | arm64 | Not in current CI matrix  | Pending native evidence    |
| Windows | x64   | Native CI: Node 24        | Public User Install target |
| macOS   | x64   | No current CI claim       | Deferred                   |
| macOS   | arm64 | No current CI claim       | Deferred                   |

The developer runtime support matrix and standalone release evidence are separate. Linux
x64 SEA help/version and gateway bootstrap run on Node 24. Linux arm64 requires a native
ARM64 machine or runner before any standalone claim. Windows x64 is built and smoke-tested
on a native Windows runner and is distributed as a User Install through the Git Bash
bootstrap; the installed runtime itself is native and does not depend on Git Bash or Node.
Windows System Install/service mode remains out of scope. macOS x64/arm64 are deferred.

## Module layout

Source lives under `src/`, mapping to ARCHITECTURE components:

| Path                | Component                           |
| ------------------- | ----------------------------------- |
| `src/app`           | Application bootstrap / composition |
| `src/auth`          | Authorization server (OAuth/PKCE)   |
| `src/config`        | Configuration model and lifecycle   |
| `src/control-plane` | Local control plane                 |
| `src/gateway`       | Extension gateway + supervisor      |
| `src/kernel`        | Minimal tool kernel                 |
| `src/observability` | Audit, metrics, logging             |
| `src/policy`        | Policy engine                       |
| `src/protocol`      | Protocol compatibility adapters     |
| `src/router`        | Request router                      |
| `src/shared`        | Shared contracts and utilities      |
| `src/standalone`    | Verified manifest/install/rollback  |
| `src/task`          | Managed Runner + Task Coordinator   |

Tests mirror this under `tests/` (`unit`, `integration`, `conformance`, `e2e`).
Sample configuration lives under `config/`.

## Tooling commands

| Command                        | Description                                       |
| ------------------------------ | ------------------------------------------------- |
| `npm run build`                | Emit compiled output to `dist/`                   |
| `npm run build:sea:linux-x64`  | Build Linux x64 SEA artifact                      |
| `npm run smoke:sea:linux-x64`  | Boot packaged deny-all gateway                    |
| `npm run build:sea:win32-x64`  | Build Windows x64 SEA on a native Windows runner  |
| `npm run smoke:sea:win32-x64`  | Boot packaged Windows x64 gateway                 |
| `npm run typecheck`            | Type-check without emitting                       |
| `npm run lint`                 | ESLint (type-aware)                               |
| `npm run lint:fix`             | ESLint autofix                                    |
| `npm run format`               | Prettier write                                    |
| `npm run format:check`         | Prettier check                                    |
| `npm test`                     | Run unit tests (Vitest)                           |
| `npm run test:watch`           | Watch mode                                        |
| `npm run test:coverage`        | Coverage report                                   |
| `npm run check`                | typecheck + lint + format:check + test            |
| `npm run docs:check`           | Verify public docs/CLI contract                   |
| `npm run provenance:inventory` | Generate locked dependency/license inventory      |
| `npm run release:gate`         | Verify standalone version/build/hash identity     |
| `npm run benchmark`            | Build then record local performance baseline JSON |

ESM-only (`"type": "module"`). Source imports must use explicit `.js` extensions for
NodeNext resolution (e.g. `import { x } from "../kernel/tool-identity.js"`).

## Performance baselines

`npm run benchmark` launches clean child processes from `dist/` with an ephemeral
owner verifier and deny-all policy. It records raw samples plus ceiling-rank p50/p95/p99 for
CLI `--help` cold start and gateway readiness. On Linux it also records RSS at readiness.
It does not contact external services and does not impose a failing budget before CI has a
stable baseline. CI Node 24 uploads the JSON as `performance-baseline-linux-x64-node24`.

## Code conventions

- **Strict TypeScript** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`).
- **Immutability** by default — mark records/values `readonly`.
- **Type-only imports** preferred (`consistent-type-imports` → `type-imports`).
- Usage of `any` is an error; `unknown` is preferred for external input.
- No magic numbers. Centralised error handling. No comments unless they carry
  rationale (the project follows a no-noise-comment style).
- Naming: `camelCase` for functions/variables, `PascalCase` for types, canonical tool
  ids are `kebab/provider.tool` (e.g. `core.read`).
- Every new or modified module carries the module docstring header:
  `"""Module Name — one-line description. Wing: <wing> | Topic: <topic> | Updated: YYYY-MM-DD"""`.

## Pre-commit checks

Run the full gate before opening a PR:

```bash
npm run check
```

## Adding dependencies

- Prefer small, well-maintained, permissively-licensed packages.
- Record the dependency in `PROVENANCE.md` with version, license, and purpose.
- Never commit secrets or `.env*` files.
