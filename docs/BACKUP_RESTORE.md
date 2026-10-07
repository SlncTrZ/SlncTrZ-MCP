# Backup and Restore

Data preservation and recovery for SlncTrZ-MCP Gateway.

---

## 1. Important State Files

State directory contains:

- `installation.json`, `policy.json`, `command.json`: System configuration and execution policy.
- `secrets/owner-passphrase`: Owner dashboard authentication secret.
- `oauth-grants.sqlite3`: OAuth grants and connection profiles (supports schema v3).
- `debate.sqlite3`, `audit.sqlite3`: Debate history and security audit logs.
- `harness/`: Global agent instructions and custom skills.

Note: Task Runtime state is in-memory only and resets on restart.

---

## 2. Procedures

### Backup

```bash
# Quiesce or stop service
slnctrz-mcp stop

# Archive state directory to secure backup location
# Restart service
slnctrz-mcp start
```

### Restore

1. Stop the gateway service.
2. Restore the state directory from backup.
3. Run `slnctrz-mcp repair` to verify permissions and database integrity.
4. Start gateway and confirm health via `slnctrz-mcp doctor`.
