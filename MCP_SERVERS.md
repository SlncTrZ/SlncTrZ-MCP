# MCP Server Management

Downstream providers are optional owner-managed integrations. Their installed versions,
tool counts and readiness come from runtime discovery, not this repository.

## 1. Provider Setup & Discovery

1. Install or start the downstream server independently. For STDIO, confirm its executable
   works as the gateway's OS account; for HTTP, confirm that account can reach the endpoint.
2. In Owner Console, open **MCP Servers** and add its provider ID/name, transport and required
   command/cwd or URL. Use the provider's documented credential flow where authentication is needed.
3. Test the provider and synchronize its catalog. Review the resulting status; adding a
   definition alone does not establish a working connection.
4. Refresh discovery in your AI client and inspect `core.ping`. Use advertised tool names and
   schemas rather than guessing them from the provider's marketing name.

From v0.4.3, select a provider to open its authenticated detail drawer. Test/Sync actions
are guarded; Disable/Remove require confirmation. Workspace display names do not change
provider identity or authorization.

The pending v0.4.5 drawer displays observed `serverInfo` name/version, negotiated MCP
protocol and observation time from startup or Test/Sync, not the configured manifest version.
These are provider-reported observations, not independent binary attestation. Opening the
drawer does not probe. Missing fields remain unknown; metadata/probe cache is process-local.
The newest captured observation is shown even if the provider is now unavailable, so check
status and timestamp. Contract/schema versions are not guessed or obtained through automatic
help calls. Local command paths can be revealed/hidden; argv/env remain excluded. Tools shows
the accepted total, unchanged by filtering, and its list uses available panel height.

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

One automatic replay is allowed only for an explicit pre-dispatch session rejection that
proves no tool execution occurred, after recovery within the original deadline. Other failed
or cancelled mutations are not replayed. Persistent faults can quarantine the affected
provider within the bounded incident budget; inspect status before retrying uncertain effects.

The v0.4.5 source fix keeps cancellation request-local: it does not restart/quarantine a
healthy shared provider or mutate its recovery incident. Cancellation before dispatch or
while queued retains its classification. Genuine provider timeouts/faults still recover.
This does not guarantee rollback of remote mutations.

Optional owner-configured Prediction Seam telemetry uses provider ID `cyberbrain` specifically,
not an arbitrary example namespace. It is disabled by default; see
[Deployment](docs/DEPLOYMENT.md#5-optional-cyberbrain-prediction-seam). Keep it disabled on
v0.4.4 when avoiding the known learning-deadline restart defect; apply the v0.4.5 fix through
a verified published update when available.

Gateway-only hides gateway coding tools; provider tools retain their own authority. A STDIO
process is isolated for supervision, not an OS sandbox. Remote application lifecycle remains
the provider/controller's responsibility.

See [Provider Standard](MCP_PROVIDER_STANDARD.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
and the optional [CyberBrain guide](docs/MCP-GUIDE.md).
