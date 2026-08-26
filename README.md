# SlncTrZ-MCP

> **Universal MCP Gateway** — a local-first, policy-controlled MCP infrastructure
> gateway that connects AI web clients to controlled local capabilities through one
> stable public endpoint.
>
> Status: proposed · License: Apache-2.0 · Architecture: minimal trusted kernel with
> isolated extensions

SlncTrZ-MCP is an **infrastructure gateway**, not a script. It sits between AI web
clients and the capabilities they use, enforcing filesystem, execution, identity, and
secret boundaries by _mechanism_ rather than by prompt instruction.

## What it does

- **One stable MCP endpoint** to AI clients over HTTPS ingress.
- **OAuth + PKCE** authorization and client identity.
- **Minimal trusted tool kernel** (`core.read`, `core.write`, `core.edit`,
  `core.exec`, `core.search`).
- **Universal extension gateway** — third-party MCP servers (GitHub, Postgres,
  Docker, etc.) run in isolated child processes under a supervisor.
- **Policy engine** as the single authorization authority with live, atomic reload.
- **Local control plane** for workspace, capability, extension, and token management.
- **Audit and redaction pipeline** with privacy-preserving observability.

> SlncTrZ-MCP is an **independent, clean-room implementation**. Reference repository
> material is kept outside tracked source (see `PROVENANCE.md` and PLAN §2.1).

## Documentation

| Document                             | Contents                                                               |
| ------------------------------------ | ---------------------------------------------------------------------- |
| [`PLAN.md`](PLAN.md)                 | Development plan: purposes, phases, roadmap, risks, definition of done |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System architecture, components, invariants, failure model             |
| [`ENGINEERING.md`](ENGINEERING.md)   | Supported Node.js / OS matrix, tooling, conventions                    |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Build, test, and contribution workflow                                 |
| [`SECURITY.md`](SECURITY.md)         | Security policy and vulnerability reporting                            |
| [`PROVENANCE.md`](PROVENANCE.md)     | Dependency license inventory and provenance rules                      |
| [`docs/adr/`](docs/adr/)             | Architecture Decision Records                                          |

## Quick start (developer mode)

```bash
npm install
npm run build
npm test
npm run check
```

See [`ENGINEERING.md`](ENGINEERING.md) for the supported Node.js and operating-system
matrix and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).
