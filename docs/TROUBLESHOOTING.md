# Troubleshooting

Start with the product diagnostics:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
```

Use `--json` when collecting machine-readable evidence.

`doctor` is read-only. It does not repair or delete state.

## Windows installation issues

### Windows release target unavailable

If setup reports that the release does not contain `win32-x64`, that release predates Windows end-user packaging or is not a supported Windows release. Use the current/latest release that explicitly advertises Windows x64.

### Git Bash / cygpath missing

Windows bootstrap requires Git for Windows. Run the installer from Git Bash and ensure `cygpath` is available.

### SmartScreen / unsigned binary

The first Windows distribution tier may be unsigned. Verify that the download came from the official GitHub release and that the published SHA-256 matches. Do not infer Authenticode signing when the release notes do not claim it.

### Windows path conversion failed

Pass absolute paths. Git Bash paths such as `/c/Users/Alice/work` are converted to native Windows paths before setup. Avoid ambiguous relative paths.

### Windows launcher/current.json failure

Run `slnctrz-mcp.exe doctor`. The top-level installed launcher delegates to the verified executable selected by `current.json`. Repair may restore a missing launcher but never activates unverified bytes.

### Windows uninstall pending deletion

When uninstall is invoked from the installed Windows executable, program-directory removal is deferred until the launcher processes exit because Windows locks running executables. State/config policy still follows the selected uninstall mode.

## Common diagnostic codes

### installation_metadata_missing

The CLI cannot find a valid managed installation.

Actions:

- confirm the expected state root exists;
- set `SLNCTRZ_STATE_ROOT` only when intentionally using a non-default state root;
- rerun the documented setup/bootstrap or restore `installation.json` from backup.

### installed_release_integrity_failed

The active standalone binary or release metadata does not match the verified size/SHA-256 contract.

Actions:

```bash
slnctrz-mcp rollback
```

or, when the missing item is a safe non-secret generated asset:

```bash
slnctrz-mcp repair
```

Do not overwrite the active binary manually.

### running_version_mismatch

The verified active installed release differs from the authenticated gateway process currently running.

Action:

- restart the gateway/service;
- rerun `status` and `doctor`;
- do not continue update/rollback operations until installed and running versions agree.

### running_identity_unavailable

The health endpoint is reachable but the CLI could not read authenticated loopback build identity.

Possible causes:

- Owner Passphrase was rotated but gateway not restarted;
- loopback control plane is unavailable;
- wrong state root/passphrase file.

### gateway_unreachable

The configured health endpoint did not respond.

User mode:

- start the generated launcher;
- confirm the configured port is free.

System mode:

```bash
systemctl status slnctrz-mcp.service
journalctl -u slnctrz-mcp.service
```

### policy_invalid

`policy.json` is malformed or semantically invalid.

Do not let repair silently replace customer policy. Restore a known-good backup or correct the policy through an explicit owner-approved action.

### policy_migration_required

The daemon found a valid legacy schema-v1 policy. Normal runtime deliberately refuses to migrate it during startup.

Run the supported setup/update migration path so the legacy policy is backed up and converted explicitly, then start the gateway again. The daemon does not rewrite the legacy bytes on its own.

### path_os_permission_denied

A configured Path exists in gateway policy but the runtime OS account cannot perform the required read/write/traverse operation.

Actions:

- fix filesystem ownership/mode/ACL;
- or remove/change the Path in Owner Console.

For System Install, test permissions as the real invoking user shown by setup/systemd (`User=` in `slnctrz-mcp.service`). SlncTrZ-MCP does not create a dedicated service account.

### command_catalog_invalid

`command.json` is malformed or contains invalid command entries.

If the file is missing, `repair` recreates the platform default by filtering the shipped candidate template to executables available to the runtime user, then strictly compiles the persisted subset. If `command.json` exists but is invalid or unreadable, inspect/fix it explicitly; repair does not overwrite owner-managed content.

### owner_secret_missing

The Owner Passphrase recovery file is unavailable.

Ordinary repair deliberately does **not** regenerate an existing installation credential.

Restore it from backup. If deliberately rotating a valid credential, use:

```bash
slnctrz-mcp owner rotate-passphrase
```

### owner_secret_permissions_unsafe

On POSIX, the Owner Passphrase file is accessible to group/other users.

`repair` can restore the private mode when the file itself is otherwise valid.

### provider_store_invalid

The MCP provider store is malformed or contains invalid records.

Inspect provider configuration and credentials separately. Do not delete provider credentials as a generic repair step.

### audit_store_missing

The audit database does not exist yet.

Start the gateway once. If the warning persists, inspect state-root permissions and startup logs.

### usage_store_missing / usage_unavailable

The Usage dashboard cannot open or query `<stateRoot>/usage.sqlite3`. This is an observability failure, not an execution-policy failure: normal MCP operations should continue.

Check state-root ownership/permissions, free disk space, and startup logs for `[usage-sqlite]` or `[usage]` diagnostics. Do not delete `audit.sqlite3`, policy, credentials, or provider state as a generic fix. If historical usage is unimportant and the gateway is stopped, a damaged usage database can be preserved for inspection and recreated separately; collect evidence before destructive recovery.

### disk_space_low

Free space near the install root is below the diagnostic threshold. Free space before update so a new immutable release can be downloaded and retained alongside the previous version.

## Port conflicts

Setup checks the requested port on a fresh installation.

If setup reports `port_in_use`, choose another stable port:

```bash
slnctrz-mcp config set port 3200
```

For a fresh setup, pass `--port 3200`.

## Public URL problems

Public URLs must be HTTPS and use exact path `/mcp`.

Valid:

```text
https://mcp.example.com/mcp
```

Invalid examples:

```text
http://mcp.example.com/mcp
https://mcp.example.com/custom/mcp
https://user@example.com/mcp
https://mcp.example.com/mcp?token=...
```

Return to local mode with:

```bash
slnctrz-mcp config set public-url local
```

## Gemini Spark does not return to its confirmation page

Gemini Spark may leave its authorization tab in the background after SlncTrZ accepts the Owner
Passphrase. In this case the server has approved the request, but the browser does not continue the
Google redirect until that request is opened explicitly.

1. Cancel the failed Gemini connection and start a new connection.
2. After entering the configured Client ID and Client Secret, select **Continue**.
3. On the SlncTrZ `/authorize` page, open browser DevTools and select **Network** before entering
   the Owner Passphrase.
4. Enter the passphrase and click **Approve exactly once**.
5. In Network, right-click the request starting with
   `https://oauth-redirect.googleusercontent.com/r/...` and select **Open in new tab**.
6. Wait for Gemini's success/confirmation page. Do not reuse the old authorization page.

Never refresh, go back, or approve the same transaction again: pending authorization transactions
and authorization codes are single-use. Do not copy or share the Google redirect URL because it
contains a temporary authorization `code` and `state`.

This workaround is specific to the observed Gemini Spark flow. ChatGPT, Claude, and Grok normally
complete the redirect automatically after one approval. It does not require a callback wildcard,
manual `client.env` edits, or a gateway restart.

## OAuth reconnect after restart

Dynamic client registrations are durable, but authorization-in-progress state, access tokens, and refresh tokens are intentionally process-memory state. After restart/update/rollback, a client may need to reconnect or complete OAuth authorization again.

This is expected behavior unless a future release explicitly changes the token persistence contract. If a client cannot reconnect, verify public URL/Host/Origin configuration and then repeat owner approval.

## Managed tasks after restart

Task Runtime state is intentionally process-memory state in the current product. A gateway restart/update/rollback clears active Runner and Coordinator task IDs/state. This is expected and is separate from durable OAuth client registration, policy/provider state and audit history.

If `task.get` returns not found after a restart, create/start the work again rather than assuming the gateway lost a durable task record. Cancelling or disconnecting a `task.wait` request does not cancel a still-running Runner task; use `task.cancel` explicitly while the gateway process is still alive.

## Update failures

Update is fail-closed around:

- HTTPS download/redirect validation;
- declared artifact size;
- SHA-256;
- immutable version conflicts;
- activation metadata.

A failed artifact verification does not replace the active release.

For System Install, service restart/health failure is surfaced. Inspect service logs before retrying.

## Repair boundaries

`repair` may:

- restore the generated launcher;
- restore a missing discovered/default command catalog from the platform candidate template;
- clean stale staging files;
- correct safe Owner Passphrase mode;
- restore a missing install identity marker only after current release integrity verifies.

It does not:

- replace customer policy;
- delete providers or credentials;
- regenerate a missing Owner Passphrase;
- switch authority mode;
- remove Paths;
- purge state;
- trigger rollback automatically.

## Uninstall safety

`uninstall` requires `--yes`.

Before deleting managed roots it verifies independent install-root and state installation markers. If they do not match, uninstall stops rather than guessing ownership.

Default uninstall preserves config and state.

System Install runs under the real invoking non-root OS user and does not create a dedicated `slnctrz` account. Uninstall therefore removes only product-managed roots selected by the uninstall mode and never attempts to delete the user's OS account.

## Collecting support evidence

Useful non-secret outputs:

```bash
slnctrz-mcp --version
slnctrz-mcp --build-info
slnctrz-mcp status --json
slnctrz-mcp doctor --json
```

Do not publish:

- Owner Passphrase;
- provider credentials;
- OAuth tokens;
- raw private file contents;
- secret environment values.

## Image reading and chat display

| Symptom                                               | Check / action                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media.read_image` is absent                          | Check the running build and `core.read` authority. Source code or KB notes do not deploy a tool. After an approved release update, refresh the client's tool catalog if needed. Older `core.ping` results may have no `media` field. |
| `core.read` reports `invalid_encoding` for a PNG/JPEG | It is a UTF-8 text reader. Use the advertised `media.read_image` tool.                                                                                                                                                               |
| Image reader returns `invalid_encoding`               | Content is unsupported or has malformed container headers. Renaming an extension does not convert the format.                                                                                                                        |
| Image reader returns `too_large`                      | The initial reader accepts at most 4 MiB and 25 megapixels. Supply a smaller supported image; the reader does not resize it.                                                                                                         |
| Access denied                                         | Check configured Paths, documentation-only restrictions, symlink containment and runtime OS permissions.                                                                                                                             |
| Model sees an image but the user does not             | Attach/embed the actual image in the final answer using client-supported file handling. Tool-output-only display was insufficient in the tested ChatGPT Work session.                                                                |
| Broken `sandbox:` link                                | The link must refer to a real attachment in the current chat runtime, not a remote gateway path or a path copied from a previous session.                                                                                            |
| Model cannot consume image content                    | Verify the client preserves `content[]` image blocks and the active model accepts image input. Metadata alone is not an image.                                                                                                       |

`media.read_image` checks container headers and dimensions, not a full pixel decode.
The initial version preserves original bytes and EXIF without orientation normalization.
Do not claim that every corrupt image is detected or that user-visible rendering is guaranteed.

See [Images in chat](IMAGES.md) for the verified attachment workflow and release boundaries.
An audio attachment playing for the user is also not proof that the model can hear it;
the tested session explicitly rejected audio input.

## Coding context and skills

If tools return `context_required`, refresh the MCP tool catalog and call `context.bootstrap`.
Pass its `contextToken` as `slnctrzContext` with work calls. `context_stale` means instructions,
skills, policy or the receipt lifetime changed: bootstrap again and load relevant skills again.
Preflight rejection means the requested operation was not executed; do not apply that assumption
to arbitrary command failures.

Check `core.ping.harness` or `slnctrz-mcp config show --json` for the actual global root. Unreadable,
oversized or invalid UTF-8 AGENTS.md files block context; malformed individual skills are listed in
diagnostics. Skill scripts are not automatically executed or given permissions. A missing project
AGENTS.md is normal. See [HARNESS.md](HARNESS.md) for limits and recovery.
