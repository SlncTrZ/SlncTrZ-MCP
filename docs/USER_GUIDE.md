# SlncTrZ-MCP User Guide

**Owner-controlled access from Web AI to your Linux or Windows machine — files, commands, Agent Skills, tasks, and MCP servers through one gateway.**

This guide is for the person running the gateway. SlncTrZ-MCP is more than an MCP proxy: it is the owner-controlled layer that lets Web AI work with the machine where files and projects actually live. This guide covers first login, authority controls, AI-client connection, Agent Skills, MCP providers, and the v0.3.1 Usage dashboard.

If you only want to get running, follow the first four sections. The deeper security and deployment documents are linked at the end.

## 1. Open the Owner Console

Setup prints the Owner Console URL. For a local install it normally looks like:

```text
http://127.0.0.1:3100/owner
```

For a public gateway it is usually:

```text
https://mcp.example.com/owner
```

Sign in with the **Owner Passphrase** created during setup. The recovery copy is stored under:

```text
<stateRoot>/secrets/owner-passphrase
```

Keep it private. It controls the owner-facing configuration surface.

The Owner Console is deliberately separate from model-facing MCP tools. A connected AI client cannot call `owner.*` because those tools do not exist.

## 2. Choose how much authority the gateway has

SlncTrZ has two authority modes.

### Restricted - recommended starting point

Built-in file tools stay inside configured **Paths**. `core.exec` may start only configured **Commands**.

This is a capability boundary, not a full OS sandbox. If you approve a general-purpose tool such as Bash, PowerShell, Python, Node, Docker, or `sudo`, that child process can use the OS permissions of the account running SlncTrZ.

### Autonomous

Core tools may use the filesystem and executable authority of the gateway OS account. SlncTrZ does not silently elevate above that account, but Autonomous can still be very powerful.

Use it only when that is the behavior you want.

## 3. Add the Paths you actually need

In **Owner Console → Paths**, add the project or workspace roots the AI should use.

Examples:

```text
/home/alice/projects
D:\Projects
/srv/workspace
```

In Restricted mode, built-in file tools are contained under these roots after canonical-path checks. OS permissions still apply.

A good default is to grant a project/workspace root rather than your entire home directory.

## 4. Review Commands

Fresh Restricted setup discovers which commands from the shipped platform candidate list are actually installed, then persists and strictly compiles that usable subset.

Review the list in **Owner Console → Commands**. Remove anything you do not want an agent to launch.

Treat shells, interpreters, package managers, Docker, privilege tools, and system-management commands as high-impact capabilities. A short allowlist is easier to reason about than a broad one.

## 5. Connect an AI client

Point the client at the MCP endpoint printed during setup:

```text
http://127.0.0.1:3100/mcp
```

or, for a cloud-hosted client:

```text
https://mcp.example.com/mcp
```

After authentication, a capable client should call:

```text
core.ping
context.bootstrap
```

`core.ping` reports the active gateway orientation. `context.bootstrap` loads coding instructions, the compact skill catalog, and a short-lived context receipt used by ordinary gateway work calls.

### ChatGPT and Grok

These clients normally use dynamic registration + PKCE. You usually do not need to copy the static Client ID or Client Secret into them.

### Claude

Claude uses the configured static Client ID/Secret. Complete the OAuth flow, then approve access with the Owner Passphrase.

### Gemini Spark compatibility step

Gemini Spark currently needs one extra browser step in the flow we have tested:

1. Enter the configured Client ID and Client Secret in Gemini.
2. Continue until Gemini opens the SlncTrZ authorization page.
3. Before entering the Owner Passphrase, open browser DevTools → **Network**.
4. Enter the Owner Passphrase and click **Approve exactly once**.
5. In Network, find the request beginning with:

   ```text
   https://oauth-redirect.googleusercontent.com/r/...
   ```

6. Right-click that request and choose **Open in new tab**.

Do not share, re-submit, or repeatedly reopen that one-time URL. It contains OAuth state/code material. ChatGPT, Claude, and Grok have completed the tested flow without this manual new-tab step.

Normal gateway restarts preserve acknowledged OAuth grants/token families, with access/refresh credentials stored only as hashes/metadata. A browser authorization flow already in progress is different: pending authorization transactions and codes are process-local, so restart that flow after a gateway restart instead of reusing an old callback/code URL.

## Core file tools you will see

The built-in file surface uses the current names `core.read`, `core.search`, `core.write`, and `core.edit`. They all remain subject to the active authority/policy boundary; their presence does not grant access outside configured authority.

## 6. Use global instructions and Agent Skills

Global coding context lives under the state root:

```text
<stateRoot>/harness/AGENTS.md
<stateRoot>/harness/skills/<skill-name>/SKILL.md
```

Project context is optional. When a client explicitly bootstraps an authorized project root, SlncTrZ can also discover project `AGENTS.md` and project skills.

The harness uses progressive disclosure:

```text
context.bootstrap
  → instructions + compact skill catalog

skills.read(name)
  → full SKILL.md only when needed

skills.read(name, resource)
  → one referenced text resource when needed
```

v0.3.1 limits are intentionally bounded:

| Context item             |           Limit |
| ------------------------ | --------------: |
| `AGENTS.md`              | 32 KiB per file |
| `SKILL.md`               |         256 KiB |
| YAML frontmatter         |           8 KiB |
| Referenced text resource |  1 MiB per read |
| Active skills            |             128 |

These limits let us support substantial skills without turning every bootstrap into a giant context injection.

## 7. See usage and context savings

Open:

```text
/usage
```

For a local default install:

```text
http://127.0.0.1:3100/usage
```

The page itself contains no private data. It loads its data from owner-authenticated endpoints under `/owner/api/usage/*`, so sign in at `/owner` first.

The dashboard shows:

- measured MCP request/response traffic;
- estimated tokens entering and leaving the gateway;
- usage by tool;
- 24-hour, 7-day, 30-day, and retained-history views;
- the hypothetical eager-load size of the active skill catalog;
- the skill context actually disclosed;
- estimated context avoided by progressive disclosure;
- estimated cost avoided using the input-token price you enter locally.

### What the number means

SlncTrZ measures **the gateway boundary**, not your entire model session.

It does not count:

- the full prompt you type into a webchat;
- system/developer context injected by the chat platform;
- hidden reasoning;
- the model's normal prose answer;
- exact provider billing usage.

v0.3.1 uses the versioned model-neutral estimator `utf8-bytes-v1`, approximately four UTF-8 bytes per token. The byte counts are measured. Token and dollar figures are estimates.

### Privacy of usage history

Usage data is stored separately at:

```text
<stateRoot>/usage.sqlite3
```

The schema contains numeric/classification metadata. It does not persist prompts, tool arguments, file contents, command output, provider payloads, credentials, bearer tokens, or context receipts.

If usage telemetry fails, the dashboard may become unavailable, but normal MCP work is designed to continue.

## 8. Add another MCP server

Open **Owner Console → MCP Servers → Add MCP**.

You can add:

- a remote Streamable HTTP MCP endpoint; or
- a local stdio MCP process.

SlncTrZ probes the provider before committing it. Enabled provider tools are exposed under a stable namespace:

```text
<provider-id>.<tool-name>
```

Choose a short provider ID that will remain meaningful even if you replace the implementation later. For example, `kb` is usually a better long-term namespace than a vendor/version-specific name.

Credentials live in managed secret storage and are not copied into model-visible tool metadata.

See [MCP_SERVERS.md](../MCP_SERVERS.md) for detailed provider configuration.

## 9. Verify the installation

Start with:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
```

Then verify from the AI client:

```text
core.ping
context.bootstrap
```

Check that the returned Paths, authority mode, tools, skill catalog, and provider readiness match what you configured.

If the client was already connected before an upgrade that changes the MCP tool catalog, reconnect/refresh the MCP connection so the client performs a fresh `tools/list` discovery.

## 10. Update, rollback, repair, and recovery

```bash
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

- **Update** installs and verifies a new immutable release before activation. After the signing-enabled trust bootstrap, it authenticates `manifest.json` with the embedded Ed25519 public key before parsing and then verifies artifact size/SHA-256.
- **Rollback** activates a previously verified release.
- **Repair** restores only safe generated state; it does not silently reset owner credentials or customer policy.
- **Rotate passphrase** is an explicit owner action and requires a gateway restart afterward.

Task runtime state is intentionally in memory and does not survive restart. Audit and usage history are persistent SQLite state, and acknowledged OAuth grants/token families are durable; pending OAuth authorization transactions/codes remain in memory.

## 11. If something is wrong

Use:

```bash
slnctrz-mcp doctor --json
```

Then see [Troubleshooting](TROUBLESHOOTING.md).

For public deployments, also read [Deployment](DEPLOYMENT.md), [Security](../SECURITY.md), and the [Threat Model](THREAT_MODEL.md). Those documents describe the real boundaries and residual risks; they are not marketing material.
