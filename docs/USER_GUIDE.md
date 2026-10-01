# SlncTrZ-MCP User Guide

This guide is for the person running the gateway. Start with [installation](../README.md#quick-start),
then follow the steps below. Commands and file paths refer to the gateway machine.

## 1. Start the gateway and sign in

A User Install runs in the foreground: use the `Start:` command printed by setup and keep
that process running. A Linux System Install starts a systemd service automatically.
See [Deployment](DEPLOYMENT.md) for launch commands and default locations.

Open the Owner Console URL printed by setup. The local default is:

```text
http://127.0.0.1:3100/owner
```

Setup prints the path of the private Owner Passphrase file, not the passphrase value.
Read the file locally and use it to sign in:

```text
<stateRoot>/secrets/owner-passphrase
```

Keep it private. It controls gateway configuration. The Owner Console is separate from the
AI tool surface; there are no `owner.*` MCP tools.

## 2. Choose authority and Paths

| Mode           | What you grant                                                                    |
| -------------- | --------------------------------------------------------------------------------- |
| **Restricted** | Built-in file tools use configured Paths; command starts use the Commands catalog |
| **Autonomous** | Tools use the filesystem and executable permissions of the gateway OS account     |

Start with Restricted. In **Paths**, add the project directories the AI should use, such as
`/home/alice/projects` or `D:\Projects`. These are paths on the gateway, not on the AI client's device.
The gateway account must also have the required OS permissions.

In **Commands**, review the installed executables provisioned during setup. Remove commands
you do not want an agent to launch. Bash, PowerShell, Python, Node, Docker and privilege tools
are powerful: an approved child process can exercise the gateway account's OS permissions.
Restricted mode is not a full OS sandbox. See [Autonomy](AUTONOMY.md) before changing modes.

## 3. Connect your AI client

Local clients use the loopback endpoint. Cloud-hosted clients require a reachable public HTTPS
endpoint, reverse proxy/tunnel, and matching configuration; follow [Deployment](DEPLOYMENT.md).

```text
Local:  http://127.0.0.1:3100/mcp
Public: https://mcp.example.com/mcp
```

Add the endpoint in the client and complete authorization on the gateway's approval page.

| Client         | Connection notes                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------- |
| ChatGPT / Grok | Normally use dynamic registration + PKCE; no static Client Secret needed                       |
| Claude         | Use the configured static Client ID/Secret from the private `client.env` file printed by setup |
| Gemini Spark   | May need the browser redirect workaround described below                                       |

These notes describe connection procedures. Release-specific compatibility requires testing
with the actual client. Never paste credentials, OAuth callback URLs, or authorization codes into
a chat or support issue.

### Gemini Spark redirect workaround

If the observed Gemini flow does not finish automatically:

1. Start a fresh connection using the configured Client ID/Secret.
2. On the gateway authorization page, open browser DevTools → **Network**.
3. Enter the Owner Passphrase and click **Approve exactly once**.
4. Find the request beginning with `https://oauth-redirect.googleusercontent.com/r/...`.
5. Right-click it and choose **Open in new tab**.

The URL contains temporary OAuth code/state. Do not share it, approve again, or reuse an old
callback. See [Troubleshooting](TROUBLESHOOTING.md#gemini-spark-does-not-return-to-its-confirmation-page)
if this does not resolve the flow.

## 4. Manage connections and tool profiles

Each authorization creates a Connection (OAuth grant) in **Owner Console → Connections**.

| Action                  | Result                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Rename (pencil control) | Changes only the display label                                                                                                       |
| Full profile            | Exposes authorized coding/file/media/context/skills/task tools and provider tools                                                    |
| Gateway-only profile    | Keeps `core.ping`, `connection.restrict`, Debate tools and enabled provider tools; hides coding/file/media/context/skills/task tools |
| Delete                  | Immediately revokes this grant; the client must authorize again to reconnect                                                         |

Profiles filter the tools of one connection; they do not change the gateway's Restricted/Autonomous
authority. A connection can restrict itself to Gateway-only; restoring Full requires the Owner.
Deleting a grant does not delete a dynamically registered client record.

After a profile change or upgrade, refresh/reconnect the client's MCP discovery. Ask the agent
to call `core.ping` and check the returned profile, authority and available tools.

For **Full** connections, the agent calls `context.bootstrap` before ordinary work.
Gateway-only hides that tool; provider calls in that profile do not require gateway context.

Acknowledged OAuth grants/token families survive normal gateway restarts. Pending browser
authorization transactions/codes do not; start a new authorization flow if a restart interrupts it.

## 5. Use files, instructions and skills

On Full connections, the file tools are `core.read`, `core.search`, `core.write` and `core.edit`.
They use the authority you configured. Preview writes/edits with `dryRun:true`;
calls apply by default. Existing-file replacement/edit uses the file's SHA-256 to reject stale edits.

Global editable guidance lives at:

```text
<stateRoot>/harness/AGENTS.md
<stateRoot>/harness/skills/<skill-name>/SKILL.md
```

Edit `AGENTS.md` for working preferences. Install a skill as its own directory containing a
`SKILL.md`. Setup seeds starter skills once and preserves later edits and intentional deletions.

The agent reads the compact catalog at bootstrap and loads a full skill with `skills.read`
only when relevant. Optional project context adds that project's instructions/skills.
Instructions guide work; they do not grant permissions. See [Harness](HARNESS.md) for format,
limits, setup and context renewal.

## 6. View an image together with your agent

Ask the agent to use `media.read_image` for an authorized PNG/JPEG. The tool accepts up to
4 MiB and 25 megapixels, preserving the original bytes without resizing or OCR.

The client must support image input for the model and attachments for user-visible display.
If you want to see the image in chat, ask the agent to attach/embed it in its final reply.
A successful read does not guarantee that your particular chat UI displays it.
See [Images in chat](IMAGES.md) for client requirements and limitations.

## 7. Add another MCP server

Open **MCP Servers → Add MCP**. Choose a Remote URL or Local command, enter the provider
details and authentication, then select **Probe & Add**.

The provider must pass discovery before it is saved and enabled. Tools appear as
`<provider-id>.<tool-name>`. Use **Test** to diagnose availability, **Sync** to accept an updated
catalog, and **Disable/Enable** to hide/restore its tools without removing configuration.

Credentials are stored separately from tool metadata. See [MCP Servers](../MCP_SERVERS.md)
for field examples, Windows paths and authentication limits.

## 8. See usage and context savings

Sign in at `/owner`, then open `/usage`. It shows measured MCP traffic, per-tool estimates,
skill-context savings and 24h/7d/30d/retained-history views.

Byte counts measure gateway traffic. `utf8-bytes-v1` estimates tokens at roughly four UTF-8
bytes per token; dollar values use the price you enter locally. These are estimates of the
gateway boundary, not your full ChatGPT/Claude/Google bill.

The separate `<stateRoot>/usage.sqlite3` ledger stores numeric/classification metadata.
It excludes prompts, arguments, file contents, command output and credentials.
If persistence fails, normal MCP work continues; the dashboard may show degraded/drop health
or incomplete history.

## 9. Tasks and Debates

| Feature           | Use                                        | Persistence                                |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| Runner task       | Run an authorized command asynchronously   | In memory; cleared on gateway restart      |
| Coordination task | Share logical work/claims between clients  | In memory; cleared on gateway restart      |
| Debate            | Alternate messages between two connections | History and turn state in `debate.sqlite3` |

Tasks use the existing authority; task text grants no permission. The agent uses `task.start`
and later `task.get`/`task.wait`; cancelling a wait does not cancel the command.
Use `task.cancel` for the running task.

For a Debate, ask one agent to create a topic and the other to join using its ID and nickname.
The creator sends the first turn after the second participant joins. Agents read the current
turn, send their argument and wait for the other participant.
You can inspect history, stop a Debate or resume a timed-out one from the Owner Debate page
linked in the console.

Each `debate.wait` request lasts at most **20 seconds**. For an overall five-minute wait,
the agent repeats bounded calls until its chosen deadline. That HTTP timeout does not end a turn:
the default turn pickup deadline is two minutes and the response deadline is fifteen minutes.

Deletion is permanent. An active Debate must be stopped first; deleting it also removes its
messages. Debate content is stored intentionally, unlike metadata-only audit/usage history.
Keep credentials and private secrets out of Debate topics/messages.

## 10. Verify, update and recover

Use the installed CLI, or its absolute launcher/executable path if it is not on PATH:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

- **Status/doctor:** inspect installation and running identity; doctor is read-only.
- **Update:** verifies signed manifest and artifact bytes before activating a new immutable release.
- **Rollback:** verifies the previous installed release and switches activation. Check release notes for state compatibility.
- **Repair:** restores bounded generated state; it preserves owner policy and does not regenerate a lost credential.
- **Rotate passphrase:** explicitly creates a new recovery-file value. Read that file locally and restart the gateway before using the new passphrase.

Before lifecycle changes, back up state and config together; see [Backup and Restore](BACKUP_RESTORE.md).
After restart, Full clients bootstrap again and recreate unfinished tasks. OAuth grants and Debate
history are durable; context receipts, Owner sessions and pending OAuth transactions are not.

If something fails, run `slnctrz-mcp doctor --json` and follow
[Troubleshooting](TROUBLESHOOTING.md). Share only relevant diagnostics with secrets removed.
