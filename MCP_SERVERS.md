# MCP Server Management

Downstream providers are optional owner-managed integrations. Their installed versions,
tool counts and readiness come from runtime discovery, not this repository.

## 1. Provider Setup & Discovery

Use the Owner Console MCP Servers panel to add a provider, test it, synchronize its catalog
and enable/disable it. Check `core.ping` and refresh the client's advertised tool catalog after
a change. A configured provider is not necessarily ready.

| Transport       | Gateway behavior                                                      | What must already exist                                          |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| STDIO           | Starts and supervises a child with configured command/cwd/environment | Executable and dependencies accessible to the gateway OS account |
| Streamable HTTP | Connects to the configured endpoint with bounded requests             | Independently running reachable MCP server                       |

`server/discover` is a modern MCP protocol negotiation method used by the adapters, not an
internal endpoint for scanning machines. Legacy providers use the supported initialization
fallback. Tools are exposed as `<provider-id>.<tool-name>`; call the actual advertised help
tool before relying on provider schemas. CAD engines and CyberBrain are examples, not defaults.

## 2. Credentials & Safe Rotation

Non-secret provider definitions live in `<stateRoot>/mcp/providers.json`; credentials live
behind a separate boundary in `<stateRoot>/mcp/credentials/` and are referenced opaquely.

Credential rotation must activate the new credential before retiring the old reference.
Activation/rollback is transactional and tested, but external outages and reconnects can
still interrupt availability. If rotation or sync fails, inspect status rather than repeatedly
replaying a potentially mutating provider call. Never copy credentials into docs, logs or prompts.

## 3. Recovery & Boundaries

A stale-session call fails once and is not automatically replayed; later calls may recover
within the bounded incident budget. Persistent failures can quarantine the affected provider.
Inspect the Owner panel and diagnostic result before retrying.

Gateway-only hides gateway coding tools; provider tools retain their own authority. A STDIO
process is isolated for supervision, not an OS sandbox. Remote application lifecycle remains
the provider/controller's responsibility.

See [Provider Standard](MCP_PROVIDER_STANDARD.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
and the optional [CyberBrain guide](docs/MCP-GUIDE.md).
