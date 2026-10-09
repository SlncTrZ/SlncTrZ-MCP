# Troubleshooting Guide

Start with the symptom, then check the running artifact and profile. Published baseline:
v0.4.2. A source version alone does not identify an installed process or prove a fix is deployed.

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
the operation preserves managed files on startup failure. The current helper uses absolute
system binaries and does not depend on PowerShell being on PATH. Historical release failures
are recorded in [Project Status](PROJECT_STATUS.md); verify deletion on your installed target.

Windows Authenticode signing is not claimed; publisher authenticity comes from the
Ed25519-signed manifest and its artifact hash.

## 6. Provider / Tool Missing

Inspect core.ping, the connection profile and the Owner MCP Servers panel. Gateway-only
hides coding, media, context, skills and task tools. Configured providers can be unavailable;
sync/reconnect must succeed before discovery reflects them. A failed provider call is not
automatically replayed. Read the advertised provider help and preserve uncertain mutation
outcomes before retrying.

See [MCP Servers](../MCP_SERVERS.md), [Images](IMAGES.md) and [Project Status](PROJECT_STATUS.md).

## 7. A CLI works in your terminal but fails through the gateway

Inspect in this order: **executable/PATH → OS account → home/config location → config
exists → auth/permissions/keyring**. A “not logged in” response from one subprocess does
not prove the whole machine lacks a login.

| Check       | Linux                                                                          | Windows                                                                   |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Executable  | Resolve its absolute path as the gateway account                               | Resolve its executable/launcher and quoting as the gateway account        |
| Account     | Compare foreground/service user; a service does not inherit your login session | Compare console/service/task account; another account has another profile |
| Home/config | Check HOME, configured XDG directories and CLI-specific overrides              | Check USERPROFILE, actual APPDATA/LOCALAPPDATA and CLI-specific overrides |
| Config/auth | Confirm expected directory exists; use the CLI's safe status check             | Check ACLs/keyring/session availability under the same account            |

The unreleased WP-00-E fix retains a minimal home/config environment for `core.exec` and
`task.start`: Linux HOME resolves through the OS account when absent; configured XDG
directories and GH_CONFIG_DIR are retained. Windows uses its profile and actual known
app-data folders, including redirected locations. It does not inherit arbitrary variables
or automatically forward API keys/tokens. Config-directory resolution is not universal
keyring or installed-service acceptance.

On affected published v0.4.2, command filtering can omit Linux HOME. For an existing
GitHub CLI config, an explicitly configured `GH_CONFIG_DIR` may be a scoped workaround
after checking the account/location; it is a directory override, not a credential. On that
affected filter, set it inside the explicitly authorized wrapper/child command that launches
the CLI; setting the gateway's parent environment alone does not make the filter forward it.
A shell/interpreter wrapper still needs policy authorization. Do not hard-code somebody
else's home or copy token files between accounts. Apply the exec-env
fix only through a reviewed build/update; source changes do not repair the running gateway.

Do not run auth login, rotate the Owner passphrase or paste config contents just because
one command failed. Inspect redacted diagnostics and CLI help; record only directory
resolution, version and exit status. Successful gh smoke does not certify every CLI/keyring.

## 8. Owner page briefly shows Sign in or data does not load

| Symptom                                            | First check                                 | Recovery                                                                                     |
| -------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Sign in appears while a session is being checked   | Running version/build and network trace     | Published v0.4.2 can show an initial login flash; the development fix is unreleased          |
| Data API returns 500/network/429                   | Session and data responses separately       | Resolve/retry the failed request; do not assume expired OAuth or rotate credentials          |
| Session/data API returns 401                       | Actual authentication result                | Sign in through Owner UI; keep protected content hidden until checked                        |
| Mutation returns CSRF 403                          | Error code and session state                | Recheck the session, then deliberately retry the intended action after reviewing its outcome |
| Owner UI is unavailable after setting a public URL | Owner Web setting and allowed hosts/origins | Review explicit enablement; the public MCP URL is not the private control-plane URL          |

The unreleased WP-05 UI keeps Sign in hidden until an auth result, offers Error/Retry for
session/data failures, preserves the authenticated shell on data errors, and rechecks after
history restoration. Retry reloads session/data; it does not automatically replay a mutation.
Browser fixtures on Linux/Windows verified those changes, but no live /auth redirect or
production cookie defect was established. Do not weaken cookie/CSRF policy to hide a flash.
