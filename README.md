# SlncTrZ-MCP

> **Universal MCP Gateway** — a local-first, policy-controlled MCP infrastructure
> gateway that connects AI web clients to controlled local capabilities through one
> stable public endpoint.
>
> Status: Phase 7 local control plane and observability implemented · Linux Node 22/24
> acceptance passed · Phase 5/6 Windows acceptance `npm run check` (typecheck, lint, format, 263 tests) and
> `npm run build` pass on Node 24.18.0 · License: Apache-2.0 · Architecture: minimal trusted
> kernel with isolated extensions

SlncTrZ-MCP is an **infrastructure gateway**, not a script. It sits between AI web
clients and the capabilities they use, enforcing filesystem, execution, identity, and
secret boundaries by _mechanism_ rather than by prompt instruction.

## What it does

- **One stable MCP endpoint** to AI clients over HTTPS ingress.
- **OAuth + PKCE** authorization and client identity.
- **Minimal trusted tool kernel** — `core.read`, `core.search`, policy-gated
  `core.write`, `core.edit`, and POSIX fixed-command `core.exec` are available (Windows
  `core.exec` is fail-closed).
- **Universal extension gateway** — operator-declared third-party MCP servers run
  out-of-process over fixed stdio or HTTPS transports under bounded supervision.
- **Policy engine** as the single authorization authority with live, atomic reload.
- **Explicit project context** — bounded, provenance-visible instruction files requested
  through MCP resources/prompts and treated as untrusted user context.
- **Loopback owner control plane** for redacted policy/capability views, extension health,
  atomic reload, revocation, metrics, and audit export.
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
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Kernel, policy, and extension-gateway threat gates                     |

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
- Owner control plane: `http://127.0.0.1:3101`

Remote ingress must supply an explicit public URL, hostname allowlist, and an
owner-secret scrypt verifier from a secret store or protected runtime environment:

```bash
SLNCTRZ_HOST=0.0.0.0 \
SLNCTRZ_PORT=3100 \
SLNCTRZ_CONTROL_HOST=127.0.0.1 \
SLNCTRZ_CONTROL_PORT=3101 \
SLNCTRZ_TELEMETRY_ENABLED=true \
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

Machine authorization is default-deny. One operator-owned JSON policy
(`SLNCTRZ_POLICY_FILE`) declares workspace roots, client bindings, capability profiles,
fixed exec registries, extension manifests, workspace/profile extension grants, and
explicit instruction sources/budgets. An absent file compiles a deny-all snapshot, so an
authenticated client sees only
`core.ping`. Each request selects an explicit workspace (and profile for multi-profile
workspaces) after authentication; unknown or unauthorized selectors return 403. Reload
compiles a complete candidate off-side and activates it atomically; invalid manifests,
namespace collisions, or invalid grants retain the prior snapshot. Risk-increasing
changes remain behind the approval hook. See ADR-018 and ADR-020.

Filesystem capabilities are independently default-deny. `SLNCTRZ_TOOL_ROOT` enables
`core.read` and `core.search`; `SLNCTRZ_WRITE_ROOT` separately enables `core.write` and
`core.edit`. Writes and edits default to dry-run, and replacing an existing file or
editing it requires its current SHA-256; edits accept only exact-match replacements and
never create a file. Omit `SLNCTRZ_WRITE_ROOT` for a read-only deployment. `core.exec`
is POSIX-only and requires `SLNCTRZ_EXEC_ROOT` together with `SLNCTRZ_EXEC_COMMANDS_FILE`
(a fixed command-registry JSON); the registry and exec root are operator-owned and must
not be writable by the service identity or any workspace root. See ADR-014, ADR-015,
ADR-016, and ADR-017.

## Extension gateway

Extension manifests describe technical capability and transport only; they cannot grant
workspace access. Policy `extensionGrants` are the single authorization source. Each MCP
exchange captures one immutable snapshot/runtime generation, and discovery exposes only
tools that are both authorized and ready. Provider tool drift, malformed discovery,
crashes, timeout, queue/output overflow, or quarantine fail closed without falling back
to another provider. Retired supervisors drain active exchanges before stopping, and
extension audit events omit arguments, results, endpoints, environment data, credential
references, and raw provider errors.

Stdio providers use a fixed absolute executable, fixed arguments, `shell: false`, a
minimal explicit environment, and bounded protocol/output handling. Streamable HTTP
providers use a fixed HTTPS endpoint with same-origin redirects only. This is process and
protocol isolation, not an OS sandbox; run the gateway with a restricted service identity.
See ADR-020.

## Project context

Workspace policy may explicitly declare bounded user, workspace, and directory-local
instruction files:

```json
{
  "instructions": {
    "userFiles": ["/absolute/path/to/user-guidance.md"],
    "workspaceFiles": ["AGENTS.md"],
    "directoryFileNames": ["AGENTS.local.md"],
    "maxFiles": 32,
    "maxFileBytes": 65536,
    "maxContextBytes": 32768
  }
}
```

The gateway does not scan home directories or auto-inject contents. Authenticated clients
can inspect provenance at `slnctrz://context/index` and explicitly request the
`project-context` prompt for a workspace-relative directory. Returned instruction text
has the MCP `user` role and a warning that it cannot override product safety or
authorization policy.

Resolution is deterministic: user files precede workspace files, followed by
directory-local files from the deepest directory toward the workspace root. Each source
reports a non-sensitive identifier/display path, SHA-256, size, estimated token count,
precedence, and loaded/referenced/error status. Whole-file and total-context budgets avoid
partial instruction injection; non-fitting content remains referenced. Secret paths,
escapes, symlinks, malformed UTF-8, and oversized files fail closed. Adding sources,
reordering them, or widening budgets requires policy approval. See ADR-009.

## Scoped development access

An operator may grant an AI web client a workspace-scoped development profile. This is
not an unrestricted shell: Phase 3.1 execution selects only operator-authored fixed
commands, with explicit roots, bounded output, audit attribution, and no inherited
gateway environment. Broader developer workflows require an explicit policy change and
must not silently expand a client’s authority.

Policy reload is atomic. The separate loopback control plane can inspect the redacted
policy and owner-approve a complete reload, but there is no file watcher, public MCP reload
tool, direct policy editor, owner CLI, or browser UI. It also exposes redacted status,
extension health, bounded audit/metrics, and owner-authorized client/token revocation.
Every request requires the owner secret as an Authorization bearer value; never place it
in a URL or log. See ADR-021.
Deployments should run the gateway as a non-root service account with explicit OS-level
filesystem restrictions. A full runtime sandbox is deferred; it becomes required before
free-form execution, untrusted code, broad network access, or multi-tenant operation.
See ADR-019.

See [`ENGINEERING.md`](ENGINEERING.md) for the supported Node.js and operating-system
matrix and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).
