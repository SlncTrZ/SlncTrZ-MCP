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
4. Restricted execution requires an authorized Path plus a strict command-catalog match; default provisioning may filter unavailable platform candidates before persistence, but the kernel compiler itself never silently accepts unresolved entries.
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
18. After the signing-enabled trust bootstrap, release manifests must pass Ed25519 publisher verification before parsing; artifact size + SHA-256 and exact build provenance remain required before activation.
19. OAuth redirect URIs remain exact-match values. A previously unseen Gemini custom-MCP callback may be persisted only for the configured static Client ID, only after successful Owner authentication, and only when it passes the bounded Google callback classifier; wildcard matching and DCR-client mutation are forbidden.
20. Owner-secret abuse budgets count failed authentication attempts, not successful Owner logins/approvals; once a direct-peer failure budget is exhausted, subsequent authentication attempts from that peer fail closed until its bounded window resets. This preserves the pre-KDF CPU-abuse cutoff and can create a bounded shared-peer lockout behind one ingress; forwarding headers are not trusted implicitly.
21. Host and Origin allowlists are enforced before Owner Console, OAuth, and MCP application dispatch; liveness/readiness endpoints remain intentionally outside the Origin gate.

## Secrets

Never commit real tokens, passphrases, private keys or provider credentials. Runtime secrets belong in owner-managed secret state or environment files with restrictive permissions and are referenced by opaque identifiers where applicable.

The production Ed25519 release-signing private key is a release-pipeline secret, not runtime state. It must exist only as the `SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64` secret of the protected GitHub `release-signing` Environment; do not keep a repository-level duplicate with the same name. The public verification key may be a repository/environment variable and is embedded in signing-enabled standalone binaries.

Tracked examples and tests may contain clearly synthetic placeholder secrets only.

## Audit and privacy

The default audit model is metadata-oriented. It may record identity, request/tool category, policy/build identity, result and duration. It must not record credentials, full model prompts, task instructions/results, file contents, command stdout/stderr or provider payloads by default.

If durable audit storage is enabled, the same privacy boundary applies to persisted records.

## Usage telemetry privacy

The v0.3.1 `/usage` feature is passive observability, not policy. It stores its own bounded metadata in `<stateRoot>/usage.sqlite3`; `audit.sqlite3` remains the security/attribution journal.

The usage schema excludes prompts, MCP request bodies, tool arguments, paths, file contents, command output, provider payloads, credentials, bearer tokens, and context receipts. It stores numeric byte/token estimates plus coarse request/tool classification. Usage persistence is fail-open: losing telemetry may make `/usage` incomplete, but it must not authorize, deny, replay, or fail ordinary MCP work. The authenticated Owner usage API exposes bounded degraded/drop health so telemetry loss is visible without becoming an authority dependency.

Token and dollar figures are estimates. They are not provider billing records. See [ADR-028](docs/adr/adr-028-passive-usage-telemetry.md) and [Threat Model](docs/THREAT_MODEL.md).

Our security model has broad automated coverage, but this project has not earned an independent-audit claim merely from internal tests. We welcome external review and treat new evidence as part of the release process.

## Deployment security

Standalone production deployments use the self-contained verified SEA and do **not** require a system Node.js installation. Source/developer deployments must use the package engine contract `>=22.13.0 <25`.

System Install uses root/sudo only for privileged setup operations and runs the gateway as the validated real non-root invoking user. It must preserve `NoNewPrivileges`/capability hardening where compatible with configured Paths, render the runtime user/group and command-discovery PATH into systemd, and run immutable versioned artifacts through the generated launcher rather than copying individual compiled files into a live tree.

Public deployment must use HTTPS for non-loopback MCP/OAuth identity. The separately authenticated control plane remains loopback-only and must not be reverse-proxied publicly.

Fresh bootstrap acquisition remains an external trust boundary: downloads are HTTPS-only and redirects are bounded/validated, but the first signing-enabled binary must itself be obtained through a trusted bootstrap path. Once that trust root is active, setup/update fetches `manifest.json` plus `manifest.json.sig`, verifies the Ed25519 publisher signature before parsing the manifest, and only then accepts artifacts whose declared size + SHA-256 match. Destructive uninstall requires matching independent installation identity markers.

The live gateway reports semantic version and exact build/commit provenance; `status`/`doctor` compare authenticated running identity with the active verified installed release when available.

## Coding context receipts

The harness preflight verifies delivery workflow, not model understanding or authorization.
Global/project instructions and skills cannot grant capabilities. Dedicated bounded context
reads do not add their roots to general Paths. Receipts are client/workspace/policy/revision-bound,
expire and are kept in bounded memory. They are separate from OAuth credentials. Kernel checks
still run after preflight. Ping, context lifecycle and owned task cancellation remain available
for recovery. The host owns conversation boundaries and retention across compaction.
