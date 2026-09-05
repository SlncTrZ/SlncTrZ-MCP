# Security Policy

## Supported versions

Security fixes target the **latest release** and the `main` branch. Older releases are supported on a case-by-case basis.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.** Report privately through a secure project channel. If no private channel is available, create a private draft and request a secure handoff.

Include:

- affected component/version;
- minimal reproduction or failing test;
- impact and proposed mitigation when known;
- whether the issue is already public.

## Current security model

SlncTrZ-MCP has two explicit authority modes. They are intentionally different security contracts.

### Restricted mode

Restricted mode is capability-controlled by owner-managed configuration:

```text
Paths + Commands + enabled MCP Servers
```

Core filesystem operations stay inside configured Paths and apply the protected-secret path policy. `core.exec` additionally requires a command present in the owner-managed command catalog and an authorized working Path.

Restricted mode is **not a complete OS sandbox**. If the owner authorizes a general-purpose shell or interpreter, that child process can exercise the permissions of the gateway OS account.

### Autonomous mode

Autonomous mode deliberately follows the authority of the gateway OS user:

```text
model authority ≈ gateway process authority ≈ OS-user authority
```

In this mode the restricted-mode Path boundary and protected-secret path deny are not presented as containment guarantees. The operating-system account, filesystem ACLs, service hardening, container/VM policy and network controls become the authoritative boundaries.

SlncTrZ-MCP does not silently elevate privileges.

## Security invariants

The following invariants apply to the current schema-v2 product model:

1. Public MCP requests require valid OAuth authorization before tool dispatch.
2. Restricted filesystem operations stay inside configured Paths and enforce the restricted secret-path policy.
3. Autonomous filesystem operations follow gateway OS-user authority; they must not be described as restricted-path containment.
4. Restricted execution requires an authorized Path plus a command-catalog match; autonomous execution follows OS-user authority.
5. `task.start` uses the same execution authority as `core.exec`; Task Runtime is not a second privilege path.
6. Writable Paths do not by themselves grant execution authority in restricted mode.
7. Extension credentials are provider-scoped and are not exposed in MCP metadata, normal errors or audit payloads.
8. Untrusted extension processes do not execute inside the gateway core process.
9. Provider tool names cannot collide silently and runtime tool drift fails closed.
10. Policy/provider/command authority mutation is transactional: a failed candidate must not leave rejected durable authority or partially replace the active generation.
11. Provider credential rotation stages new secret state and activates a generation using it before retiring an unreferenced old credential; failed rotation must preserve prior usable state or report recovery failure explicitly.
12. Logs and audit schemas must not disclose credentials or model/file/task payload contents by default.
13. Product/project instruction text, provider descriptions and coordination-task text cannot grant capabilities.
14. Coordination tasks are workspace-visible logical state; exactly one claimant owns claimant-only mutations, while creator cancellation remains explicit.
15. Graceful gateway shutdown owns managed child/process/provider cleanup; SIGKILL/forced termination that prevents handlers from running is not claimed to provide graceful cleanup.
16. Owner administration is not exposed as model-facing `owner.*` MCP tools.
17. The local control plane is separately authenticated and must not be reachable as a public MCP route.
18. Release artifacts must be checksum-verified before activation and should be attributable to an exact version/build provenance.

## Secrets

Never commit real tokens, passphrases, private keys or provider credentials. Runtime secrets belong in owner-managed secret state or environment files with restrictive permissions and are referenced by opaque identifiers where applicable.

Tracked examples and tests may contain clearly synthetic placeholder secrets only.

## Audit and privacy

The default audit model is metadata-oriented. It may record identity, request/tool category, policy/build identity, result and duration. It must not record credentials, full model prompts, task instructions/results, file contents, command stdout/stderr or provider payloads by default.

If durable audit storage is enabled, the same privacy boundary applies to persisted records.

## Deployment security

Standalone production deployments use the self-contained verified SEA and do **not** require a system Node.js installation. Source/developer deployments must use the package engine contract `>=22.13.0 <25`.

System Install should use the dedicated non-root `slnctrz` account, preserve `NoNewPrivileges`/capability hardening where compatible with configured Paths, and run immutable versioned artifacts through the generated launcher rather than copying individual compiled files into a live tree.

Public deployment must use HTTPS for non-loopback MCP/OAuth identity. The separately authenticated control plane remains loopback-only and must not be reverse-proxied publicly.

Release/bootstrap downloads are HTTPS-only, redirects are bounded/validated, and artifact activation requires declared size + SHA-256 verification. Destructive uninstall requires matching independent installation identity markers.

The live gateway reports semantic version and exact build/commit provenance; `status`/`doctor` compare authenticated running identity with the active verified installed release when available.
