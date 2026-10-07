# User Guide

Practical operations guide for SlncTrZ-MCP Gateway.

---

## 1. Installation & Endpoints

Supported on Linux and Windows x64 with Git Bash:

- Windows program directory: `%LOCALAPPDATA%\SlncTrZ-MCP`; state: `%USERPROFILE%\.slnctrz-mcp`
- Owner web dashboard: `http://127.0.0.1:3100/owner`
- AI client MCP endpoint: `http://127.0.0.1:3100/mcp`

---

## 2. CLI Commands

Common service management commands:

```bash
# Service status and health
slnctrz-mcp status
slnctrz-mcp doctor

# View active configuration
slnctrz-mcp config show

# Update to latest release
slnctrz-mcp update

# Roll back after a bad upgrade
slnctrz-mcp rollback

# Database and permission repair
slnctrz-mcp repair

# Rotate owner web console passphrase
slnctrz-mcp owner rotate-passphrase

# Uninstall completely
slnctrz-mcp uninstall --yes
```

---

## 3. Releases & Integrity

- Release status is determined by the published GitHub release with cryptographic verification against the Ed25519 trust root.
- Upgrades automatically verify release signatures before activating new binaries.

---

## 4. Core Tools

- `core.read`: Read files within allowed Paths.
- `core.search`: Fast regex/text search within allowed Paths.
- `core.write`: Atomic file write.
- `core.edit`: Exact-match targeted string replacement.

---

## 5. Agent Context & Skills

- Agents run `context.bootstrap` at session start to load harness guidance and available skills.
- Specific skill definitions are read progressively via `skills.read`.

---

## 6. Tasks and Debates

- Background execution is managed via `task.start`.
- Two-party debate logs are tracked in SQLite for verifiable engineering decisions.
