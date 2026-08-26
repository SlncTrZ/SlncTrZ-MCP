# Provenance

This document records the provenance and license obligations of SlncTrZ-MCP and its
dependencies (PLAN §2.1, §2.5; Phase 0 acceptance: dependency licenses are inventoried).

## The project itself

- **Project:** SlncTrZ-MCP — Universal MCP Gateway.
- **License:** Apache-2.0 (`LICENSE`). Copyright 2026 Trương Công Định (SlncTrZ).
- **Provenance:** independent, clean-room implementation. Architecture is derived from
  project requirements, public MCP protocol specifications, measured behaviour, and
  independently written tests. Reference repositories and research notes are kept
  outside tracked source (`.gitignore`).

## Source provenance rules

Every production module must have clear provenance. When a design decision is derived
from an external source, attribute the _idea_ in the linked ADR or commit message and
never bring the source text in verbatim.

Sources are classified as:

- **R** — project requirement (PLAN / ARCHITECTURE).
- **P** — public protocol specification (e.g. MCP spec).
- **D** — independent architecture decision (ADR).
- **B** — observed behaviour (measured, not assumed).

## Dependency license inventory

### Runtime (planned)

No runtime dependencies are committed yet. Runtime dependencies will be added during
implementation phases and each will be recorded here with: package, version, license,
and any NOTICE obligation.

### Development (current)

| Package               | Version | License    | Purpose                  |
| --------------------- | ------- | ---------- | ------------------------ |
| `typescript`          | 6.0.3   | Apache-2.0 | TypeScript compiler      |
| `@types/node`         | 26.3.0  | MIT        | Node.js type definitions |
| `vitest`              | 4.1.11  | MIT        | Unit test runner         |
| `@vitest/coverage-v8` | 4.1.11  | MIT        | Coverage provider        |
| `eslint`              | 10.9.1  | MIT        | Linter                   |
| `typescript-eslint`   | 8.68.0  | MIT        | TypeScript ESLint rules  |
| `prettier`            | 3.9.6   | MIT        | Code formatter           |

> This table is a snapshot. Regenerate the authoritative inventory with a license
> scanner (e.g. `license-checker` / SPDX SBOM) before release; update this file to match.

## Third-party obligations

When adding a dependency, record its license and any NOTICE text. Dependencies with
copyleft obligations are evaluated before inclusion. No dependency text is copied into
this repository.
