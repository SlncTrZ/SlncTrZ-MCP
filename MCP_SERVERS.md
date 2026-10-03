# Add MCP servers

Use this guide to connect an additional MCP server to your gateway through the Owner Console.
A provider runs its own tools; the gateway handles discovery, namespacing and lifecycle.
For provider authors, see [Provider Standard](MCP_PROVIDER_STANDARD.md).

## Choose a transport

| Server                                 | Transport     | Target example                                        |
| -------------------------------------- | ------------- | ----------------------------------------------------- |
| Remote MCP over HTTPS                  | Remote URL    | `https://mcp.example.com/mcp`                         |
| MCP HTTP server on the gateway machine | Remote URL    | `http://127.0.0.1:3003/mcp`                           |
| Local executable                       | Local command | `/usr/local/bin/my-mcp`                               |
| Node script                            | Local command | Node executable as Target; script path in Args        |
| Python script                          | Local command | Python/venv executable as Target; script path in Args |

A local command runs with the gateway account's OS permissions. It is not OS-sandboxed
by the gateway. Install and review the server before adding it.

## Fill in the Owner Console

Open **MCP Servers → Add MCP**, enter the fields below, then select **Probe & Add**.

| Field       | What to enter                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Name        | Optional human-readable label                                                                        |
| Provider ID | Stable lowercase ID, starting with a letter; remaining characters `a-z`, `0-9`, `-`; 1–64 characters |
| Description | Optional short explanation                                                                           |
| Transport   | Remote URL or Local command                                                                          |
| Target      | Full MCP URL, or absolute executable path on the gateway                                             |
| Args        | Local command arguments; the normal UI splits them on whitespace                                     |
| Auth        | No auth, Bearer or HTTP header                                                                       |
| Header name | Custom header name for HTTP header auth                                                              |
| Credential  | Secret value; use this field instead of URL, Args or Description                                     |

The Args field is **not a shell parser**: quotes do not group paths containing spaces.
For example, a Windows executable Target may contain spaces, but a script path in Args cannot
be quoted into one argument through this UI. Use a script path without spaces or an owner-managed
advanced manifest with an explicit `args` array.

The gateway probes the server and discovers tools before saving/enabling it. A failed probe
must not be treated as a completed addition. After success, refresh your AI client's tool discovery.

## Common examples

### HTTPS provider

```text
Provider ID: research
Transport:  Remote URL
Target:     https://mcp.example.com/mcp
Auth:       Bearer, HTTP header, or No auth as required by the server
```

Enter the credential only in the private Credential field. HTTP header auth also requires
the exact supported header name, such as `X-API-Key`.

Remote URLs must use HTTPS. HTTP is allowed only for loopback hosts on the gateway machine
(`localhost`, `.localhost`, `127.0.0.0/8`, `::1`, and supported IPv4-mapped loopback).
Private LAN addresses such as `192.168.x.x` still require HTTPS.
URLs must not contain credentials, query parameters or fragments.
Redirects must stay on the same origin, including port.

### Local Node or Python server

```text
Provider ID: my-mcp
Transport:  Local command
Target:     /usr/bin/node
Args:       /opt/my-mcp/server.js --stdio
Auth:       No auth
```

For Python, choose the absolute interpreter path, for example
`/opt/my-mcp/.venv/bin/python`, and put the script path in Args.
On Windows, use native executable/script paths, such as
`C:\Program Files\nodejs\node.exe` and `C:\mcp\server.js`.

Target is one executable path, not `node script.js` or a shell expression.
Pipes, `&&`, `;`, and command substitution do not belong in Target.
The process must speak MCP on stdin/stdout; send diagnostic logs to stderr.

Normal local-command setup uses No auth. HTTP Bearer/header credentials are for HTTP
providers, not stdio. An environment-variable credential is an advanced manifest capability,
requires `envAllowlist`, and is not offered by the normal Owner Console.

## Manage an existing provider

| Action           | Result                                                    |
| ---------------- | --------------------------------------------------------- |
| Test             | Probe availability and inspect discovered tools           |
| Sync             | Accept the current tool catalog and activate it           |
| Disable / Enable | Hide/restore tools while retaining provider configuration |
| Remove           | Remove the provider configuration                         |

Tool names are exposed as `<provider-id>.<tool-name>`, for example
`research.search`. The gateway maps the call to the provider's advertised name.
An upstream provider can advertise bare tool names; a SlncTrZ-specific `help` tool is
recommended for first-class providers, not required for generic MCP compatibility.

Credentials stay in separate private storage and are referenced by opaque IDs.
**Credential rotation must activate the new credential**: rotation is complete only when the active provider
generation uses the new credential. A failed candidate must preserve usable prior state;
do not manually overwrite/delete active credential files as a troubleshooting shortcut.

## Diagnose missing or failing tools

1. Use **Test** and inspect the provider's status in the console.
2. Ask the agent to call `core.ping` and inspect `configuredProviders`, `readyProviders`,
   `advertisedTools` and `catalogFingerprint` in the provider summary.
3. Confirm URL/transport/authentication and that the gateway can reach the server.
4. If discovery changed, use **Sync**, then refresh/reconnect the client.
5. After a temporary provider failure, wait for bounded recovery before retrying a safe call.

The failed tool call is not automatically replayed. Before retrying a write, check whether
the upstream operation committed. Repeated invalid sessions can quarantine a flapping provider.

## Compatibility and bounds

The adapters probe modern MCP `server/discover` (`2026-07-28`) and support legacy
`initialize` (`2025-11-25`). Discovery must return valid tool schemas; invalid or drifting
catalogs do not become ready silently.

Provider message/output limits default to **8 MiB**, with a **16 MiB hard ceiling**.
Startup defaults to 10 seconds and tool requests to 30 seconds.
Oversized responses and timeouts are errors; do not expect silent truncation to make
an oversized MCP message valid. Advanced limits live in the provider manifest.

## Keep credentials private

- Never put secrets in Target, Args, labels, descriptions, URLs, logs or issue reports.
- Custom auth headers cannot replace reserved transport/protocol headers such as
  `Host`, `Content-Type`, `Authorization`, or `Mcp-Protocol-Version`.
- Provider instructions and tool descriptions do not grant gateway authority.
- Read [Security](SECURITY.md) before exposing a network provider.
