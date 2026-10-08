# Troubleshooting Guide

Diagnostics for SlncTrZ-MCP (v0.5.x source). Check the running artifact and profile first;
repository version alone does not identify an installed process.

## 1. Version Mismatch

### Issue: running_version_mismatch

The installed activation differs from the process still running after update. Stop the
foreground instance through its terminal, then use the setup-generated Start command.
For Linux System Install use `sudo systemctl restart slnctrz-mcp`. Rerun status and doctor.

There are no standalone CLI start/stop subcommands. Do not terminate unrelated Node
processes to restart this gateway. If the authenticated running identity cannot be read,
inspect the private control-plane configuration and whether passphrase rotation needs restart.

## 2. Authentication & Client Connections

The acknowledged OAuth grant/token-family state are durable in SQLite
(`oauth-grants.sqlite3`); pending authorization transactions/codes are process-local.
After restart, repeat unfinished consent. Inspect Owner Connections at
`http://127.0.0.1:3100/owner` for revocation, profile ceiling and current connection state.

New Gateway-only refresh tokens have no fixed/idle expiry but rotate on every successful
refresh; a revoked grant or reused refresh token still fails. Existing migrated grants
retain finite lifetimes. Reconnect with fresh consent when a connection needs the new policy.

For a locked database, identify the writer/second instance first. For corruption, stop and
preserve a coherent backup, then inspect doctor. Repair is bounded; it does not recover
arbitrarily corrupt databases. See [Backup](BACKUP_RESTORE.md).

## 3. Managed tasks after restart

Runner/Coordinator state and context receipts clear on restart. Reconcile process/filesystem
effects before recreating tasks. `context_required`/`context_stale` means the guarded operation
was not executed: bootstrap, read guidance, then retry with the fresh receipt. Other uncertain
mutation failures require inspection before retry.

## 4. Fast Diagnostics

```bash
slnctrz-mcp --version
slnctrz-mcp --build-info
slnctrz-mcp status --json
slnctrz-mcp doctor --json
slnctrz-mcp config show
```

After reviewing the diagnosis and preserving state, `slnctrz-mcp repair` may fix supported
layout/permission problems. Never paste owner secrets, client.env or provider credentials
into support logs.

## 5. Windows Uninstall

A deferred-removal message means the self-removal helper initialized and will act after
the uninstall process exits; it is not proof that every path has already disappeared.
Check the managed program paths after exit. Default uninstall preserves state/config;
only explicit remove-config/purge changes that retention policy.

`windows_uninstall_helper_failed` or `windows_uninstall_helper_start_timeout` means startup
was not acknowledged. Inspect system CMD/PowerShell availability and Windows permissions;
the operation preserves managed files on startup failure. The v0.4.0 source fix uses absolute
system binaries and does not depend on PowerShell being on PATH. Hosted runner verification
is still required before calling the release failure resolved in CI.

Windows Authenticode signing is not claimed; publisher authenticity comes from the
Ed25519-signed manifest and its artifact hash.

## 6. Provider / Tool Missing

Inspect core.ping, the connection profile and the Owner MCP Servers panel. Gateway-only
hides coding, media, context, skills and task tools. Configured providers can be unavailable;
sync/reconnect must succeed before discovery reflects them. A failed provider call is not
automatically replayed. Read the advertised provider help and preserve uncertain mutation
outcomes before retrying.

See [MCP Servers](../MCP_SERVERS.md), [Images](IMAGES.md) and [Project Status](PROJECT_STATUS.md).
