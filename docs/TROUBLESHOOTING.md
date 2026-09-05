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

If setup reports that the release does not contain `win32-x64`, that release predates Windows end-user packaging or is not a supported Windows release. Use a 0.3.x-or-later release that explicitly advertises Windows x64.

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

A configured Path exists in gateway policy but the runtime OS account cannot read/traverse it.

Actions:

- fix filesystem ownership/mode/ACL;
- or remove/change the Path in Owner Console.

For System Install, test permissions as the `slnctrz` account.

### command_catalog_invalid

`command.json` is malformed or contains invalid command entries.

If the file is missing, `repair` may restore the minimal empty catalog. If it exists but is invalid, inspect it rather than deleting it automatically.

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

## OAuth reconnect after restart

Dynamic client registrations are durable, but authorization-in-progress state, access tokens, and refresh tokens are intentionally process-memory state. After restart/update/rollback, a client may need to reconnect or complete OAuth authorization again.

This is expected behavior unless a future release explicitly changes the token persistence contract. If a client cannot reconnect, verify public URL/Host/Origin configuration and then repeat owner approval.

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
- restore a missing minimal command catalog;
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

For System Install, the `slnctrz` OS account is retained intentionally even after purge because setup may have reused an existing account. Automatic `userdel` would risk deleting an OS identity not exclusively owned by SlncTrZ-MCP. Remove the account manually only after verifying it is unused.

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
