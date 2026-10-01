# SlncTrZ-MCP Provider Standard

> Status: Draft v0.2
> Audience: provider authors seeking first-class SlncTrZ integration.
> To connect an existing server, use [MCP Servers](MCP_SERVERS.md).

This document defines provider conventions, not additional gateway permissions.
A generic third-party MCP server can be connected without implementing every convention below.
Gateway transport/schema checks still apply.

## 1. Integration boundary

| Provider owns                                   | Gateway owns                                       |
| ----------------------------------------------- | -------------------------------------------------- |
| Domain logic, tool schemas and input validation | Registration, namespace and accepted catalog       |
| Domain persistence and side effects             | Current policy, connection profile and routing     |
| Provider authentication and credential use      | Private credential references and injection        |
| Provider help, version and health               | Readiness, lifecycle and catalog Fingerprinting    |
| Bounded dependency operations                   | Gateway-level time/message/output bounds and audit |

Neither provider instructions nor a help response grants Paths, Commands or gateway authority.
Keep business logic in the provider.

## 2. Transport and discovery

For first-class network providers, prefer MCP Streamable HTTP with a documented endpoint
(default `/mcp`). A local stdio server is also supported by the gateway.

| Transport       | Requirements                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Streamable HTTP | HTTPS for non-loopback hosts; clean endpoint without userinfo/query/fragment; same-origin redirects |
| Local stdio     | Absolute executable path, explicit argument array, MCP on stdout, diagnostics on stderr             |
| Loopback HTTP   | Only the documented loopback host exception; private LAN HTTP is not accepted                       |

The gateway probes modern `server/discover` (`2026-07-28`) and supports legacy
`initialize` (`2025-11-25`). Discovery must return valid tool definitions.
Additional REST/health endpoints do not replace the MCP endpoint.

Document the intended bind address/port and proxy deployment. Return safe errors for invalid
transport/authentication; do not return internal stack traces to untrusted callers.
Provide a lightweight health check that does not invoke destructive domain operations.

## 3. Authentication and credentials

Network-accessible first-class providers must authenticate by default.
The primary convention is `Authorization: Bearer <credential>`; an additional custom header
such as `X-API-Key` may be supported. Multiple accepted auth forms must reach the same
authorization logic.

| Outcome                                 | HTTP semantics |
| --------------------------------------- | -------------- |
| Missing/invalid authentication          | 401            |
| Authenticated identity lacks permission | 403            |

Use deployment-managed secrets, environment injection or protected configuration.
Never commit secrets, bake them into images, or expose them through URLs, Args, labels,
help content, logs or tool results.

The gateway's normal Owner UI supports No auth/Bearer/HTTP header. Stdio environment credentials
are an advanced manifest capability and require an explicit `envAllowlist`.
Public/no-auth providers are an explicit owner choice; do not claim authenticated behavior for them.

## 4. Stable provider and tool names

Gateway provider IDs:

- start with a lowercase ASCII letter;
- contain only lowercase letters, digits and hyphens;
- are at most 64 characters;
- remain stable across provider upgrades.

Advertise bare tool names, such as `help`, `knowledge_search` and `knowledge_store`.
The gateway exposes them as `<provider-id>.<tool-name>`, for example `kb.knowledge_search`.
An already-canonical name for the same provider is preserved by the namespacing path.

Tool names and schemas must be stable and explicit. Use meaningful operation names.
Describe output, validation, error behavior, persistence and destructive effects.
Validate input before effects; reject unknown/invalid fields when permissiveness could hide
unsafe behavior. Separate destructive operations from ordinary reads/updates.

## 5. Read-only help for first-class providers

A provider claiming compliance with this standard **must** expose a side-effect-free `help`
tool. This is a SlncTrZ convention, not a requirement of MCP or every third-party server.

The response should supply:

| Field                                  | Meaning                                                    |
| -------------------------------------- | ---------------------------------------------------------- |
| `provider_name`, `provider_version`    | Running implementation identity                            |
| `protocol_version`, `contract_version` | Protocol/tool-contract compatibility                       |
| `contract_hash`                        | Deterministic fingerprint of the current help contract     |
| `updated_at`                           | Contract date, when available                              |
| `authentication`                       | Safe description of supported methods, never secret values |
| `capabilities`                         | Concise capability overview                                |
| `content`                              | Current usage instructions                                 |

Read help from the provider's runtime guide where practical; mount external guidance read-only.
An embedded guide is acceptable when deployment requires it. Either way, describe the running
contract, not an unreleased source-tree intention.
Use a deterministic hash such as SHA-256 to detect changes.

## 6. Errors and reliability

Distinguish authentication, authorization, validation, not-found, conflict, rate-limit,
timeout, dependency-unavailable and internal failures. Report safe reason classes and whether
retrying can be considered; omit credentials, raw configuration and untrusted stack traces.

Bound model/API/database/storage calls and retries. Document long-running work explicitly.
Gateway defaults are 10-second startup and 30-second requests, with message/output limits
of 8 MiB and a 16 MiB hard ceiling. A provider's own deadlines may be shorter.

The gateway does not replay a failed domain tool call automatically. A caller retry can duplicate
effects if the provider committed before losing its response. Providers should document
idempotency and supply operation IDs/status checks for writes where needed.

Catalog drift must be explicit: update schemas/version, then use gateway Sync/activation.
Provider recovery is bounded; repeated invalid sessions can quarantine a flapping provider.

## 7. Versions, observability and deployment

Version provider software, tool contract and data schema separately where appropriate.
Breaking changes need a compatibility/migration decision; prefer additive changes.

Useful metadata includes tool name, success/failure class, request count, Latency and timeout
count. Redact/omit sensitive arguments and results. Never log credentials.

For containers/services:

- keep mutable data outside immutable images;
- externalize secrets and define required volumes;
- document dependencies, ports, runtime identity and restart/health behavior;
- use reproducible builds and bounded resource use.

A local stdio child is process-isolated from gateway code, but it is not OS-sandboxed by
the gateway. Use external OS/container controls for an untrusted provider.

## 8. Integration checklist

| Check           | Evidence                                                            |
| --------------- | ------------------------------------------------------------------- |
| Discovery       | Supported transport/auth; valid `tools/list` and accepted namespace |
| Safe invocation | At least one read-only call succeeds through the gateway            |
| Secrets         | No credentials in source/image/URL/Args/help/output/logs            |
| Tool semantics  | Explicit schemas, write/destructive effects and error behavior      |
| Help            | Read-only, current and fingerprinted for first-class compliance     |
| Bounds          | Dependency timeouts, retries and output/resource limits             |
| Upgrade         | Deliberate version/schema migration and catalog Sync                |
| Operations      | Health, restart behavior and safe metadata observability            |

CyberBrain is a reference integration target, not a guaranteed enabled provider.
Discover the running catalog and provider help to determine actual availability/compliance.
See [CyberBrain integration](docs/MCP-GUIDE.md) only when that provider is enabled.
