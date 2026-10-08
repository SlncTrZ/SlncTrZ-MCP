# Troubleshooting Guide

Common issues and quick recovery steps for SlncTrZ-MCP (v0.4.x).

---

## 1. Version Mismatch

### Issue: running_version_mismatch

- **Cause:** Running process differs from the installed binary on disk (usually after an update without service restart).
- **Fix:**
  1. Stop current instance: `slnctrz-mcp stop` (or terminate via Task Manager / `pkill`).
  2. Start fresh: `slnctrz-mcp start`.
  3. Validate: `slnctrz-mcp doctor`.

---

## 2. Authentication & Client Connections

### Connection or Token Failure

- **Storage model:** acknowledged OAuth grant/token-family state are durable in SQLite (`oauth-grants.sqlite3`).
- **Fix:**
  - Check the active connections list in the Owner Console at `http://127.0.0.1:3100/owner`.
  - Run `slnctrz-mcp repair` if the grants database is locked or corrupted.

---

## 3. Managed tasks after restart

- In-memory task state clears on gateway restart to avoid orphaned or unmanaged background jobs.
- Active runners should be recreated by the client agent after restart.

---

## 4. Fast Diagnostics

```bash
# Full health check
slnctrz-mcp doctor

# Service status
slnctrz-mcp status

# Safe database repair and verification
slnctrz-mcp repair
```
