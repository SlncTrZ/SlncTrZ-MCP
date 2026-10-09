# Backup and Restore

Back up a coherent stopped installation, including configuration and any custom harness
root. Backups contain credentials and private data; protect them as carefully as live state.

## 1. Important State Files

| Location                                            | Contents                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `<stateRoot>/installation.json`                     | Installation identity and managed-root metadata                               |
| `policy.json`, `command.json`                       | Owner execution policy and command catalog                                    |
| `secrets/owner-passphrase`, `mcp/credentials/`      | Sensitive owner/provider credential state                                     |
| `mcp/providers.json`                                | Non-secret provider definitions with opaque credential references             |
| `oauth-grants.sqlite3`                              | Grant/token hashes, connection labels and profiles; source supports schema v3 |
| `oauth-static-redirects.json`, `oauth-clients.json` | Static redirect and dynamic registration state                                |
| `debate.sqlite3`, `audit.sqlite3`, `usage.sqlite3`  | Debate history, bounded audit and numeric Usage telemetry                     |
| `harness/`                                          | Owner instructions, skills and resources; custom root may be elsewhere        |
| `<configRoot>/gateway.env`, `client.env`            | Runtime configuration and sensitive static client configuration               |

Confirm actual paths with `slnctrz-mcp config show` and [Operational Files](OPERATIONAL_FILES.md).
Include SQLite sidecars if present; do not copy only the main database during live writes.
Task Runtime state, context receipts, Owner sessions and pending OAuth transactions/codes
are in-memory and cannot be recovered from a state-directory backup.

## 2. Backup

1. Stop the owning foreground gateway with Ctrl+C, or stop the Linux System service with
   `sudo systemctl stop slnctrz-mcp`. There are no CLI start/stop subcommands.
2. Verify that it is stopped and writers have quiesced.
3. Archive state and config together, preserving ownership/permissions and any SQLite
   sidecars. Include an external `SLNCTRZ_HARNESS_ROOT` if configured.
4. Store the backup privately; record installed version/build and the backup timestamp.
5. Restart using the original setup-generated command or systemctl; check status/doctor.

## 3. Restore & Schema Rollback

1. Stop the gateway and preserve the current state/config before replacing anything.
2. Restore the coherent matching state/config backup, with the original identity and ACLs.
3. Use a binary compatible with the restored schemas; run doctor to inspect integrity.
4. Use repair only for its bounded safe repairs; it does not reconstruct corrupt OAuth data.
5. Start through the owning launcher/service, verify status/doctor and re-bootstrap clients.

Opening OAuth schema v1/v2 with a schema-v3-capable binary (v0.4.0 and later, including
published v0.4.2) migrates it to schema v3. Existing finite grants stay finite;
new Gateway-only grants use durable lifetimes. A pre-v3 binary rejects schema v3, so rollback
to v0.3.7 requires the pre-migration state/config backup while stopped. Binary-only rollback
is insufficient. Restoring a backup loses later OAuth changes; reconcile/re-authorize affected
connections rather than silently downgrading a live database.

## 4. Update without losing your configuration

After a coherent backup, use the installed `slnctrz-mcp update` command. It verifies the
release manifest/artifact before activation; follow its restart instruction rather than
starting a second gateway. Check `--build-info`, `status --json` and `doctor --json` after
restart, then reconnect/refresh discovery in the client.

`slnctrz-mcp rollback` changes the program activation, not the database contents. Check schema
compatibility before rollback. A backup is only usable if you can restore its matching
config, ownership and custom harness; keep those with its version/build and timestamp.

Default uninstall preserves config/state. Only choose `--remove-config` or `--purge` when
you intend that retention change. See [User Guide](USER_GUIDE.md#2-cli-commands).
