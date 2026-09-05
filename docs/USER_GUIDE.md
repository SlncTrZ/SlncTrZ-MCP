# User Guide — Owner Console: add Paths and MCP servers

> Applies to the installed standalone SlncTrZ-MCP gateway. The Owner Console is the
> owner-only admin surface for the workspace Paths and connected MCP servers.

## 1. Access the Owner Console

Open the Owner Console URL printed at setup:

```text
<mcpPublicUrl>/owner
```

Examples:

```text
https://mcp.truongcongdinh.org/owner     # public/system install
http://127.0.0.1:3100/owner              # local install
```

Login with the **Owner Passphrase** (printed on first setup, or read from
`<stateRoot>/secrets/owner-passphrase`). Keep it private — it controls the Owner Console and
the authenticated loopback control plane.

---

## 2. Add a workspace Path

File tools (`read_file`, `write_file`, `edit`, `search`) operate **only** inside configured
**Paths**. A Path is the workspace boundary the gateway grants to file tools.

**Steps (Owner Console → Paths → Add):**

1. Enter an **absolute** path, e.g.:

   ```text
   /srv/slnctrz-workspace          # Linux
   C:\Users\you\projects\acme      # Windows
   ```

2. Save. The gateway canonicalizes and validates the path, then reloads policy.

**Authority modes:**

- **Restricted** (default on fresh setup) — file tools stay within configured Paths;
  `core.exec` requires an approved command-catalog entry; `task.start` shares the same authority.
- **Autonomous** — core tools may use any path/executable available to the gateway OS account.

**Security note:** the gateway does not replace OS permissions. A Path the runtime account
cannot read/traverse still fails at the OS level. Add only directories you intend to expose.

---

## 3. Add an MCP server

The gateway connects to external MCP servers and re-exposes their tools under the canonical
namespace `<provider>.<tool>`.

**Steps (Owner Console → MCP Servers → Add MCP):**

| Field                        | What to enter                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Name**                     | Human label (not shown to clients).                                                                                           |
| **Provider ID**              | The canonical `<provider>.<tool>` namespace id — **use a virtual/abstract prefix** (see §4). Lowercase `a-z0-9-`, ≤ 64 chars. |
| **Transport**                | `Remote URL` (Streamable HTTP) or `Local command` (stdio).                                                                    |
| **Target URL** _(Remote)_    | Must be **HTTPS**; non-loopback `http://` is rejected. `http://127.0.0.1:…` (loopback) is allowed.                            |
| **Command / args** _(Local)_ | Absolute command path + space-separated args (stdio).                                                                         |
| **Auth**                     | `none`, `Bearer`, or `HTTP header` (+ header name + credential). Never put the credential in the URL.                         |
| **Description**              | Optional — what the server is for.                                                                                            |

Click **Probe & Add**. The gateway probes the endpoint (MCP `initialize` + `tools/list`).
On success it commits the provider and reloads the tool catalog; on failure it **rolls back**
(the credential may already be saved, but the provider is not activated — safe to retry).

**After adding:**

- **Test / Sync** — re-discover tools, then sync the discovered set into the catalog.
- **Enable / Disable** — add/remove the provider's tools from the catalog without deleting config.
- **Auth** — update the stored credential for an existing provider.
- **Remove** — delete the provider config (and its credential).

---

## 4. Best practice — use a virtual Provider ID (prefix ảo)

The **Provider ID** is the public namespace shown to AI clients in the tool catalog
(`<provider>.<tool>`), in `core.ping`, and in any documentation. It reveals what you connect,
so keep it **abstract**:

**Do NOT** use:

- the real service name or internal project name;
- the hostname / URL host of the server (e.g. `db-01`, `192.168.1.5`, `mycompany-internal`);
- anything that identifies where the server runs or what it really is.

**DO** use a short, stable, lowercase id that describes intent only:

```text
research   ·   vmk   ·   kb   ·   notes   ·   v2t
```

Examples of a safe vs unsafe setup for the **same** server:

```text
provider id:  research          # ✅ abstract
provider id:  internal-corp-db  # ❌ leaks the real system
```

Apply the same principle to Paths and command-catalog entries — avoid embedding absolute real
paths or server names into anything client-visible.

> **Reference:** `MCP_PROVIDER_STANDARD.md` (Section 5 _Provider Identity and Namespace_).
> Provider IDs and tool names SHOULD be lowercase ASCII identifiers; the gateway canonicalizes
> a bare tool name into `<provider>.<tool>`. When you build your own MCP server, follow that
> standard so it is predictable, authenticated by default, self-describing (mandatory read-only
> `help` tool), and secret-safe.

---

## 5. Verify your setup

```bash
slnctrz-mcp status          # paths/commands/MCP server counts + running identity
slnctrz-mcp status --json
slnctrz-mcp config show     # install/state/config paths
```

From a connected client, confirm the tools appear with the provider prefix:

```text
<provider>.help
<provider>.knowledge_search
```

If a provider is configured but tools do not appear, check readiness via the Owner Console
(Test/Sync) and confirm the transport URL + auth are correct. A provider must be **ready**
before its tools are advertised.
