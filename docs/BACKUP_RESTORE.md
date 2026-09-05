# Backup and Restore

SlncTrZ-MCP separates immutable program releases from persistent customer state.

## What to back up

### State root

User default:

```text
~/.slnctrz-mcp
```

System default:

```text
/var/lib/slnctrz-mcp
```

Important state includes:

```text
installation.json
policy.json
command.json
mcp/providers.json
mcp credential storage
secrets/owner-passphrase
OAuth client registration state
audit.sqlite3
```

### Config root

User default:

```text
~/.config/slnctrz-mcp
```

System default:

```text
/etc/slnctrz-mcp
```

Important config includes:

```text
gateway.env
```

### Install root

User default:

```text
~/.local/share/slnctrz-mcp
```

System default:

```text
/opt/slnctrz-mcp
```

The install root contains immutable program versions, release metadata, `current.json`, launcher, and installation marker.

Normally the install root does **not** need to be treated as irreplaceable customer data because verified releases can be reinstalled. Backing it up can still be useful for offline rollback.

## Secret handling

The backup contains administrative/provider credentials.

Requirements:

- encrypt backup media or use an equivalently protected destination;
- preserve restrictive file permissions;
- do not attach raw backups to support tickets;
- do not copy secrets into documentation/logs.

The Owner Passphrase recovery file is especially sensitive.

## Recommended backup procedure

Before backup:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
```

For the most consistent snapshot, stop/quiesce the gateway before copying state, especially when including the SQLite audit database.

Back up state + config together so installation identity and runtime configuration remain coherent.

Example user-mode shape:

```bash
tar -C "$HOME" -czf slnctrz-backup.tgz \
  .slnctrz-mcp \
  .config/slnctrz-mcp
```

Protect the resulting archive as a secret-bearing backup.

## Restore

1. Stop the gateway/service.
2. Restore state and config to their original absolute locations.
3. Restore ownership and private permissions.
4. Reinstall/restore the program release if necessary.
5. Start the gateway.
6. Run:

```bash
slnctrz-mcp status
slnctrz-mcp doctor
```

7. Confirm installed and running versions agree.
8. Confirm Owner Console login and provider state.

## Owner Passphrase recovery

If the gateway is stopped and the managed recovery file still exists, use that stored passphrase.

If the file is lost, ordinary `repair` does not generate a replacement because silently replacing an administrative credential would invalidate the existing security boundary.

Restore the file from backup. Explicit rotation is for a valid managed installation where the owner deliberately chooses a new credential:

```bash
slnctrz-mcp owner rotate-passphrase
```

Restart the gateway after rotation.

## Update and rollback

Update preserves prior verified release binaries and customer state.

Rollback switches the active release and preserves state. Before a future state-schema migration is introduced, the release process must define compatibility/backup behavior; rollback must fail closed rather than corrupt incompatible state.

## Uninstall and backup

Default:

```bash
slnctrz-mcp uninstall --yes
```

removes the program but preserves config and state.

`--remove-config` also removes config.

`--purge` removes program, config, state, and credentials. Back up first if you may need recovery.
