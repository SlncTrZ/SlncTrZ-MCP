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

Use supported Node 24 for development and the npm version declared in `package.json`.
The package manifest and lockfile define compiler, linter, formatter and test-runner versions;
a workstation's installed versions are not the project contract.

### Operating systems

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

| Path                | Component                                   |
| ------------------- | ------------------------------------------- |
| `src/app`           | Application bootstrap / composition         |
| `src/auth`          | Authorization server (OAuth/PKCE)           |
| `src/config`        | Configuration model and lifecycle           |
| `src/control-plane` | Local control plane                         |
| `src/gateway`       | Snapshot/store composition                  |
| `src/extension`     | Provider manifests, adapters and supervisor |
| `src/owner`         | Owner Console and managed-state lifecycle   |
| `src/debate`        | Durable two-participant Debate              |
| `src/assets`        | Shipped runtime asset access                |
| `src/kernel`        | Minimal tool kernel                         |
| `src/observability` | Audit, metrics, logging                     |
| `src/policy`        | Policy engine                               |
| `src/protocol`      | Protocol compatibility adapters             |
| `src/router`        | Request router                              |
| `src/shared`        | Shared contracts and utilities              |
| `src/standalone`    | Verified manifest/install/rollback          |
| `src/lifecycle`     | Unwired durable operation ledger foundation |
| `src/context`       | Global instructions, Agent Skills, receipts |
| `src/task`          | Managed Runner + Task Coordinator           |

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
| `npm test`                     | Run configured Vitest suites                      |
| `npm run test:watch`           | Watch mode                                        |
| `npm run test:coverage`        | Coverage report                                   |
| `npm run check`                | typecheck + lint + format:check + test            |
| `npm run docs:check`           | Verify public docs/CLI contract                   |
| `npm run provenance:inventory` | Generate locked dependency/license inventory      |
| `npm run release:gate`         | Verify standalone version/build/hash identity     |
| `npm run benchmark:harness`    | Bounded catalog/concurrency preflight baseline    |
| `npm run benchmark`            | Build then record local performance baseline JSON |

ESM-only (`"type": "module"`). Source imports must use explicit `.js` extensions for
NodeNext resolution (e.g. `import { x } from "../kernel/tool-identity.js"`).

## Performance baselines

npm run benchmark creates private temporary managed state for its gateway children and
removes the fixture on completion or failure. It does not load the account's live policy,
provider configuration or credentials. The loopback request fixture is deny-all.

It records CLI cold-start, gateway readiness/RSS and request percentiles. The JSON field
authenticatedCorePing measures the MCP protocol ping method, not a tools/call invocation
of core.ping. Do not label that number as tool-dispatch latency.

npm run benchmark:harness creates its own bounded skill fixture and measures preflight
Latency with 128 skills and stated concurrency/requests. Both are local baselines, not
remote-provider speed, SLOs or production capacity. Record node/OS and p50/p95/p99.

## Code conventions

- **Strict TypeScript** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`).
- **Immutability** by default — mark records/values `readonly`.
- **Type-only imports** preferred (`consistent-type-imports` → `type-imports`).
- Usage of `any` is an error; `unknown` is preferred for external input.
- No magic numbers. Centralised error handling. No comments unless they carry
  rationale (the project follows a no-noise-comment style).
- Naming: `camelCase` for functions/variables, `PascalCase` for types, and canonical tool
  IDs such as `core.read` or `<provider-id>.<tool-name>`. Provider IDs start with a lowercase
  letter and contain lowercase letters, digits or hyphens.
- Use TypeScript comments (`/** ... */`) for useful module purpose/rationale. Match the nearby
  code; do not add Python-style docstrings or mandatory date stamps.

## Pre-commit checks

Run the full source gate before opening a PR:

```bash
npm ci
npm run check
npm run docs:check
npm run build
npm audit --omit=dev
npm audit
npm run provenance:inventory -- --out /tmp/slnctrz-dependencies.json
```

Install dependencies on the OS executing the checks. A Windows-backed shared checkout's
node_modules cannot be reused for Linux native bindings; use an isolated Linux checkout.
Do not run simultaneous npm installs against the same dependency directory.

For packaged/embedded changes, rebuild SEA on each native target and run gateway/harness
smoke, scripts/smoke-uninstall.mjs and release:gate. Use a disposable verification key for
unpublished checks; production signing stays in the protected environment. Full checks also
cover conformance/integration suites selected by Vitest, not just unit tests.

See [Release Acceptance](docs/RELEASE_ACCEPTANCE.md) and [QA report](QA_QC_REPORT_v0.4.1.md).
Local PASS is not hosted CI or exact public-candidate acceptance.

## Adding dependencies

- Prefer small, well-maintained, permissively-licensed packages.
- Record the dependency in `PROVENANCE.md` with version, license, and purpose.
- Never commit secrets or `.env*` files.
