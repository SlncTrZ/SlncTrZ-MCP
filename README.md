# SlncTrZ-MCP

> **Universal MCP Gateway** — a local-first, policy-controlled MCP infrastructure
> gateway that connects AI web clients to controlled local capabilities through one
> stable public endpoint.
>
> Status: Phase 3 in progress · Filesystem kernel available · License: Apache-2.0 ·
> Architecture: minimal trusted kernel with isolated extensions

SlncTrZ-MCP is an **infrastructure gateway**, not a script. It sits between AI web
clients and the capabilities they use, enforcing filesystem, execution, identity, and
secret boundaries by _mechanism_ rather than by prompt instruction.

## What it does

- **One stable MCP endpoint** to AI clients over HTTPS ingress.
- **OAuth + PKCE** authorization and client identity.
- **Minimal trusted tool kernel** — `core.read`, `core.search`, and policy-gated
  `core.write` are available; `core.edit` and `core.exec` remain gated Phase 3 work.
- **Universal extension gateway** — third-party MCP servers (GitHub, Postgres,
  Docker, etc.) run in isolated child processes under a supervisor.
- **Policy engine** as the single authorization authority with live, atomic reload.
- **Local control plane** for workspace, capability, extension, and token management.
- **Audit and redaction pipeline** with privacy-preserving observability.

> SlncTrZ-MCP is an **independent, clean-room implementation**. Reference repository
> material is kept outside tracked source (see `PROVENANCE.md` and PLAN §2.1).

## Documentation

| Document                                       | Contents                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [`PLAN.md`](PLAN.md)                           | Development plan: purposes, phases, roadmap, risks, definition of done |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)           | System architecture, components, invariants, failure model             |
| [`ENGINEERING.md`](ENGINEERING.md)             | Supported Node.js / OS matrix, tooling, conventions                    |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)           | Build, test, and contribution workflow                                 |
| [`SECURITY.md`](SECURITY.md)                   | Security policy and vulnerability reporting                            |
| [`PROVENANCE.md`](PROVENANCE.md)               | Dependency license inventory and provenance rules                      |
| [`docs/adr/`](docs/adr/)                       | Architecture Decision Records                                          |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Phase 3 kernel threats and capability gates                            |

## Quick start (developer mode)

```bash
npm install
npm run check
npm run dev
```

The local endpoints are:

- MCP Streamable HTTP: `http://127.0.0.1:3100/mcp`
- Liveness: `http://127.0.0.1:3100/healthz`
- Readiness: `http://127.0.0.1:3100/readyz`

Remote ingress must supply an explicit public URL, hostname allowlist, and an
owner-secret scrypt verifier from a secret store or protected runtime environment:

```bash
SLNCTRZ_HOST=0.0.0.0 \
SLNCTRZ_PORT=3100 \
SLNCTRZ_MAX_DYNAMIC_CLIENTS=1024 \
SLNCTRZ_PUBLIC_URL=https://mcp.example.com/mcp \
SLNCTRZ_ALLOWED_HOSTS=mcp.example.com \
SLNCTRZ_ALLOWED_ORIGINS=chatgpt.com,claude.ai,grok.com \
SLNCTRZ_TOOL_ROOT=/absolute/path/to/readable/workspace \
SLNCTRZ_WRITE_ROOT=/absolute/path/to/writable/workspace \
SLNCTRZ_OWNER_SECRET_HASH='<runtime scrypt verifier>' \
npm start
```

The public MCP endpoint is default-deny. It publishes OAuth discovery, supports bounded
public client registration and authorization code with PKCE S256, rotates refresh tokens,
revokes complete token families, and verifies bearer-token resource, scope, and expiry
before dispatch. Authentication events use a structured, secret-free audit schema. The
embedded authority keeps client and token state in memory, so a restart requires clients
to reconnect. See ADR-011, ADR-012, and ADR-013.

Filesystem capabilities are independently default-deny. `SLNCTRZ_TOOL_ROOT` enables
`core.read` and `core.search`; `SLNCTRZ_WRITE_ROOT` separately enables `core.write`.
Writes default to dry-run, and replacing an existing file requires its current SHA-256.
Omit `SLNCTRZ_WRITE_ROOT` for a read-only deployment. See ADR-014 and ADR-015.

See [`ENGINEERING.md`](ENGINEERING.md) for the supported Node.js and operating-system
matrix and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).
