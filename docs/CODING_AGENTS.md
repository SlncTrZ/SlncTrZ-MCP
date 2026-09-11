# Integrating coding agents

SlncTrZ-MCP 0.3.1 exposes one authenticated MCP endpoint for chat clients, terminal agents,
IDE agents and programmatic coding harnesses. Connect the agent's MCP client to the endpoint
printed by setup, complete its supported OAuth flow, then discover the tools. Local clients can
reach a local endpoint; remote clients need network access to the gateway. File paths always
refer to the gateway machine, which may differ from the agent host.

The integration has no dependency on ChatGPT rendering, a particular model, or a desktop browser.
Agent-specific extensions are not required. Compatibility with a named UI depends on that
client's MCP transport/authentication support; protocol tests are not evidence of a live UI test.

## Model-driven integration

An ordinary MCP-capable agent can use the published tool descriptions directly:

1. Call `context.bootstrap` without projectRoot for global-only work, or with an explicit absolute
   gateway project root for optional project context.
2. Place returned instructions and the compact skill catalog in the agent's working context.
3. Pass `contextToken` as the `slnctrzContext` tool argument when calling other gateway tools.
4. Let the model select relevant skills, load SKILL.md and fetch resources as needed.
5. Close the receipt when finished.

Do not wait for a project AGENTS.md to exist. Do not load all installed SKILL.md bodies at startup.
See [the harness contract](HARNESS.md) for error handling, source precedence and limits.

## Host-managed integration

When you control the coding harness, keep the receipt in that task's runtime rather than requiring
the model to repeat it manually. Each MCP `tools/call` can carry the receipt in request metadata:

```json
{
  "name": "core.read",
  "arguments": { "path": "/work/project/package.json" },
  "_meta": { "org.slnctrz/contextToken": "<contextToken>" }
}
```

This is the `params` object, not a complete transport envelope. Let the MCP SDK add the negotiated
protocol envelope and HTTP headers. Modern 2026-07-28 calls require the protocol/client metadata
and matching `Mcp-Method`/`Mcp-Name` headers. Legacy 2025-06-18 calls are also covered by conformance
tests. Both argument and metadata receipt delivery use the same gateway checks. If both are
supplied they must match. Reserve the argument name `slnctrzContext`; the gateway strips it before
forwarding provider arguments and never forwards its receipt metadata to the upstream provider.

Keep separate receipts per independent task, conversation or worker even if OAuth credentials
are shared. A receipt is not an OAuth credential or a capability grant. Every operation still
passes the current gateway policy and existing task ownership checks.

On `context_required` or `context_stale` with `operationExecuted: false`, bootstrap again, deliver
the new instructions/catalog to the model, then retry the rejected operation. Bound recovery
retries: if bootstrap or retry fails again, report the blocker rather than looping. Never silently
refresh only the token while withholding changed instructions from the model. On host compaction,
preserve applicable instructions and activated skill contents or re-read them before proceeding.

## Division of responsibilities

| Host coding agent                            | SlncTrZ-MCP                                            |
| -------------------------------------------- | ------------------------------------------------------ |
| User interaction, model calls and agent loop | Global/project context discovery and delivery          |
| Conversation and context compaction          | Receipt/revision validation before dispatch            |
| Skill relevance judgment                     | Catalog and bounded instruction/resource reads         |
| Work planning and response rendering         | Files, commands, images, managed tasks, provider tools |
| Host-side tools and hooks                    | Gateway-side authorization and audit                   |

The gateway cannot intercept tools that an agent runs outside its MCP endpoint, control an
external host's UI, or guarantee a model's understanding. A future requirement for deterministic
gateway events can be implemented at the relevant dispatch boundary. A general extension SDK,
package store and Pi/OpenCode extension compatibility runtime are outside this release.

## Installing additional capabilities

- Put compatible skills under the configured global skills directory; metadata is discovered
  automatically. Inspect third-party instructions and their runtime requirements before use.
- Run authorized CLI/scripts through `core.exec` or `task.start`.
- Add an MCP server through the owner-managed provider lifecycle; see [MCP Servers](../MCP_SERVERS.md).

Downloading a repository does not activate an MCP provider, grant permissions, or make an
extension written for another application's API executable inside SlncTrZ.
