# Engineering Guide

Conventions, tooling, and the supported runtime matrix for SlncTrZ-MCP.

## Supported runtime versions

Source of truth is the `engines` field in `package.json` and the CI matrix.

### Node.js

| Version | Status                 |
| ------- | ---------------------- |
| `>= 22` | **Supported** (active) |
| `< 22`  | Unsupported            |

Current development environment: Node `v24.18.0`, npm `11.16.0`. TypeScript
`6.0.3`, lint with ESLint `10.9.1` and `typescript-eslint`, format with Prettier
`3.9.6`, tests with Vitest `4.1.11`.

### Operating systems (target matrix, PLAN Phase 8)

| OS      | Arch  | Developer Node runtime | Standalone SEA evidence |
| ------- | ----- | ---------------------- | ----------------------- |
| Linux   | x64   | Supported              | Verified prototype      |
| Linux   | arm64 | Supported              | Not yet verified        |
| Windows | x64   | Supported              | Not yet verified        |
| macOS   | x64   | Supported              | Not yet verified        |
| macOS   | arm64 | Supported              | Not yet verified        |

The developer runtime support matrix and standalone release evidence are separate. Linux
x64 SEA help/version and deny-all gateway bootstrap pass on Node 24. Other standalone
targets remain unsupported until native build, clean-machine boot, and required
signing/notarization evidence exists.

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

Tests mirror this under `tests/` (`unit`, `integration`, `conformance`, `e2e`).
Sample configuration lives under `config/`.

## Tooling commands

| Command                       | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| `npm run build`               | Emit compiled output to `dist/`                   |
| `npm run build:sea:linux-x64` | Build Linux x64 SEA artifact                      |
| `npm run smoke:sea:linux-x64` | Boot packaged deny-all gateway                    |
| `npm run typecheck`           | Type-check without emitting                       |
| `npm run lint`                | ESLint (type-aware)                               |
| `npm run lint:fix`            | ESLint autofix                                    |
| `npm run format`              | Prettier write                                    |
| `npm run format:check`        | Prettier check                                    |
| `npm test`                    | Run unit tests (Vitest)                           |
| `npm run test:watch`          | Watch mode                                        |
| `npm run test:coverage`       | Coverage report                                   |
| `npm run check`               | typecheck + lint + format:check + test            |
| `npm run benchmark`           | Build then record local performance baseline JSON |

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
