# Backup and Restore

Back up the gateway's **state and config together**. They contain credentials and installation
identity as well as history. Use encrypted storage or a destination with equivalent access protection.

## Locate your data

Setup prints exact locations; `slnctrz-mcp config show --json` also reports them.
Use custom paths if you changed the defaults.

| Install mode | State                        | Config                  | Program                      |
| ------------ | ---------------------------- | ----------------------- | ---------------------------- |
| Linux User   | `~/.slnctrz-mcp`             | `~/.config/slnctrz-mcp` | `~/.local/share/slnctrz-mcp` |
| Windows User | `%USERPROFILE%\.slnctrz-mcp` | `%APPDATA%\SlncTrZ-MCP` | `%LOCALAPPDATA%\SlncTrZ-MCP` |
| Linux System | `/var/lib/slnctrz-mcp`       | `/etc/slnctrz-mcp`      | `/opt/slnctrz-mcp`           |

## What to include

Copy the whole state/config directories so related records stay coherent.

| State item                                          | Why it matters                                              |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `installation.json`                                 | Installation identity and absolute locations                |
| `policy.json`, `command.json`                       | Authority, Paths and Commands                               |
| `mcp/providers.json`, `mcp/credentials/`            | Provider configuration and private credentials              |
| `secrets/owner-passphrase`                          | Owner login/recovery credential                             |
| `oauth-clients.json`, `oauth-static-redirects.json` | Dynamic registrations and approved static redirect state    |
| `oauth-grants.sqlite3`                              | Durable grants/token hashes and connection profiles/labels  |
| `debate.sqlite3`                                    | Debate topics, messages, membership hashes and turn history |
| `audit.sqlite3`                                     | Security/attribution metadata                               |
| `usage.sqlite3`                                     | Usage charts; optional if you do not need their history     |
| `harness/` including `.initialized`                 | Editable instructions, installed skills and seeding state   |

Config contains `gateway.env` and the private static OAuth client file `client.env`.
Back up a custom `SLNCTRZ_HARNESS_ROOT` separately if it is outside managed state.

The program directory holds immutable versions, release metadata, `current.json`, the launcher
and installation marker. You can normally reinstall verified releases; a program backup is
useful for offline recovery and rollback.

## Take a consistent backup

1. Record the installed version and run `slnctrz-mcp doctor`.
2. Stop the gateway. For User Install, stop its foreground process gracefully. For Linux System Install:
   ```bash
   sudo systemctl stop slnctrz-mcp.service
   ```
3. Copy state and config to a protected backup destination. Copy any SQLite `-wal`/`-shm` sidecars
   that remain with their database; do not selectively delete or omit live database files.
4. Include the program directory if offline restore is needed.
5. Restart using the printed User Install launch command or:
   ```bash
   sudo systemctl start slnctrz-mcp.service
   ```
6. Verify health and `slnctrz-mcp status`.

Do not copy a running SQLite database with an ordinary file copy and assume it is a consistent
snapshot. If downtime is unavailable, use a database-aware backup process and coordinate all state
changes; this product does not supply an automatic backup scheduler.

Managed Task Runtime state is **in-memory only**. Runner/Coordinator task IDs and context receipts
are not backup material. Recreate unfinished tasks and call `context.bootstrap` after restart.

## Restore

1. Stop the gateway and preserve any current state before overwriting it.
2. Restore state/config to the original absolute locations under the intended runtime OS account.
3. Restore private permissions/ACLs, including the credential directories and files.
4. Restore or reinstall a compatible program release and its installation marker.
5. Start the gateway and run:
   ```bash
   slnctrz-mcp status
   slnctrz-mcp doctor
   ```
6. Confirm installed/running identity, Owner login, Paths, Commands and provider availability.
7. Refresh client tool discovery; bootstrap Full connections and recreate unfinished tasks.

Installation metadata contains absolute locations and matching identities. Moving a backup to
different roots/accounts requires a deliberate installation/migration plan; changing a directory
name alone does not migrate the installation. Review release notes before restoring older binaries
against newer persistent state.

## Owner Passphrase recovery

If the recovery file exists, read it locally. Never attach it to a ticket or paste its value in chat.

If it was lost, restore it from backup or explicitly choose a new credential on a valid managed
installation with local filesystem authority:

```bash
slnctrz-mcp owner rotate-passphrase
```

The command writes a new private recovery file and reports its location. It does not require the
old passphrase; it requires discoverable installation metadata and permission to write the file.
Restart the gateway and sign in with the new value. Ordinary `repair` never rotates it silently.

## Uninstall and recovery

`slnctrz-mcp uninstall --yes` removes the program while preserving state/config.
`--remove-config` also removes config; `--purge` removes managed state and credentials too.
Make a protected backup first if recovery may be needed.

A custom harness root outside managed state is not removed by managed-state purge.
Keep backups private: they contain Owner/static-client/provider credentials, and Debate history
contains the actual conversation content.
