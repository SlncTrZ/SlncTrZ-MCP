# ADR-026: Namespace advertised provider tool ids and carry the bare exposed name

> Status: Accepted
> Date: 2026-08-31
> Owners: SlncTrZ-MCP

## Context

Adding an MCP provider through the Owner Console returned `rolled_back` with
`failedStep: "provider_saved"` and `reload.activated: false` even after the loopback-http
probe succeeded (ADR-025). The policy reload rejected the persisted provider.

Root cause: **canonical tool ids must be namespaced under the provider** (`provider.tool`,
enforced by `isValidCanonicalId` in `src/kernel/tool-identity.ts` and by
`compileExtensionRegistry` in `src/extension/registry.ts`). But a standard MCP server
reports **bare** tool names in `tools/list` (e.g. `run_pipeline`, `generate_code`). The
adoption path persisted those bare names unchanged, so `isValidCanonicalId("run_pipeline")`
failed during the reload and the policy refused to activate.

Separately, the runtime's `attestDeclaredTools` (`src/extension/runtime.ts`) compared the
declared ids against the adapter's reported bare names directly, and dispatch
(`src/protocol/mcp-server.ts`) called the adapter with the namespaced canonical id — both
of which would break once tool ids are namespaced.

## Decision

Introduce a clean separation everywhere tool ids flow:

- **`canonicalId`** = `provider.toolName` (namespaced identity used by the registry, policy,
  and the client-facing tool name). Clients always call a tool by its canonical id.
- **`exposedName`** = the bare tool name the provider/MCP server actually exposes. This is
  what `tools/list` reports and what `tools/call` must send to the server.
  `exposedName` is derived as `toolNameOf(canonicalId)`.

Concretely:

1. `src/extension/manifest.ts` — `compileExtensionManifest` sets
   `exposedName = toolNameOf(canonicalId)`, not `= canonicalId`.
2. `src/owner/mcp-provider-service.ts` — `addOrUpdate` namespaces any bare tool id to
   `${provider.id}.${toolName}` before persisting (idempotent for already-namespaced ids).
   This is the single choke point for `add`, `acceptToolSet`, and `syncToDiscovered`.
3. `src/extension/runtime.ts` — `attestDeclaredTools` compares the adapter's reported bare
   names against `toolNameOf(declaredId)`, matching bare-to-bare.
4. `src/protocol/mcp-server.ts` — dispatch calls `provider.invoke(toolNameOf(canonicalId))`
   so the adapter receives the bare name the server expects.

### Explicitly out of scope

- No change to the stdio adapter, the loopback-http exception (ADR-025), or the policy engine.
- Servers that deliberately expose namespaced tool names are treated as drift (unavailable),
  consistent with the standard MCP bare-name convention.

## Consequences

- **Positive:** providers adopted by probe (Add MCP) now persist, attest, and dispatch
  correctly; the canonical `provider.tool` contract is preserved end-to-end.
- **Negative / costs:** `exposedName` is no longer identical to `canonicalId` for namespaced
  tools, so code that previously assumed equality must use `toolNameOf` or `exposedName`.
- **Risks and mitigations:** a bare tool name containing a `.` would be split by
  `toolNameOf`. Mitigation: namespacing uses `startsWith("${providerId}.")` so only the
  provider prefix is stripped; a server exposing namespaced names drifts to unavailable
  rather than being silently mis-routed.

## Alternatives considered

- **Reject / skip bare-name servers** — leaves a common MCP pattern unsupported.
- **Store bare names and namespace only at the registry** — leaves the persisted manifest
  non-compilable and breaks the single-source contract.
- **Make the adapter prefetch and strip the namespace in `listTools`** — couples the adapter
  to provider-id naming and breaks the `canonicalId === exposedName` invariant.

## Verification

- `tests/unit/extension-manifest.test.ts` — `compileExtensionManifest` exposes the bare name.
- `tests/unit/mcp-provider-service.test.ts` — `addOrUpdate` namespaces bare tool ids.
- `tests/unit/extension-runtime.test.ts` — a provider whose server reports bare names attests
  against namespaced declared ids (ready), and a mismatched set stays unavailable.
- `npm run check` (typecheck + eslint + vitest + prettier) passes.
