# User Guide

Practical operations for the current source contract. The latest public installer can lag
behind this tree; see [Project Status](PROJECT_STATUS.md) and the published release notes.

## 1. Installation & Endpoints

Release targets are Linux x64 and Windows x64 with Git Bash for bootstrap. Installed SEA
binaries include Node; Git Bash/npm are not required to run the Windows gateway.

| Mode         | Program                    | State                      | Config                |
| ------------ | -------------------------- | -------------------------- | --------------------- |
| Linux User   | ~/.local/share/slnctrz-mcp | ~/.slnctrz-mcp             | ~/.config/slnctrz-mcp |
| Windows User | %LOCALAPPDATA%\SlncTrZ-MCP | %USERPROFILE%\.slnctrz-mcp | %APPDATA%\SlncTrZ-MCP |
| Linux System | /opt/slnctrz-mcp           | /var/lib/slnctrz-mcp       | /etc/slnctrz-mcp      |

Windows System Install is unsupported. Linux System Install needs separate systemd-host
acceptance for a verified release claim.

- Owner homepage: `http://127.0.0.1:3100/`; compatible link: `http://127.0.0.1:3100/owner`.
- Client MCP endpoint: `http://127.0.0.1:3100/mcp`.
- Owner-authenticated control plane: loopback port 3101 by default; keep it private.

Cloud clients require a reachable HTTPS MCP URL. Follow [Deployment](DEPLOYMENT.md) and
use the setup-generated `Start:` command. User installs run in the foreground;
stop that instance with Ctrl+C, then execute the same command to restart. Linux System
installs use systemctl. There are no standalone CLI `start` or `stop` subcommands.

## 2. CLI Commands

Use the installed launcher/executable path printed by setup if it is not on PATH.

```bash
slnctrz-mcp --help
slnctrz-mcp --version
slnctrz-mcp --build-info
slnctrz-mcp status --json
slnctrz-mcp doctor --json
slnctrz-mcp config show
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

Update, rollback, config changes and passphrase rotation can require restart. Check the
command's result and rerun status/doctor afterward. Repair performs bounded safe repairs;
it is not a generic recovery tool for corrupted databases. Preserve a backup before recovery.

| Uninstall command                             | Program | Config   | State    |
| --------------------------------------------- | ------- | -------- | -------- |
| `slnctrz-mcp uninstall --yes`                 | Remove  | Preserve | Preserve |
| `slnctrz-mcp uninstall --yes --remove-config` | Remove  | Remove   | Preserve |
| `slnctrz-mcp uninstall --yes --purge`         | Remove  | Remove   | Remove   |

Stop your running User gateway before uninstall. Windows self-removal is deferred until
the uninstall process exits. A successful ready handshake confirms helper startup, not
completed deletion; verify the managed paths afterward. Startup failure preserves managed
files and reports an error. Legacy/shared layouts protect retained roots.

## 3. Releases & Integrity

Release status is determined by the published GitHub release, not package version alone.
Setup/update authenticates the manifest against the Ed25519 trust root, then verifies the
binary's declared size and SHA-256 before activation. This is manifest signing; Windows
Authenticode signing is not claimed.

Before a v0.4.0 upgrade, stop the gateway and back up state plus config coherently. OAuth
schema v1/v2 migrates to v3; existing grants keep finite lifetimes and profiles. Rollback to a
pre-v3 binary needs the pre-migration backup, not binary-only rollback. See [Backup](BACKUP_RESTORE.md).

## 4. Core Tools

Full connections expose tools according to authority:

- `core.read`: Strict UTF-8 text read; `media.read_image` handles PNG/JPEG.
- `core.search`: Case-insensitive file/directory and bounded text search.
- `core.write`, `core.edit`: Atomic updates; supply `dryRun:true` for preview.
- `core.exec`: Bounded commands under the current autonomy policy.

Restricted applies Paths and the command catalog; Autonomous follows the gateway OS account.
A catalog-authorized shell is not an OS sandbox. Gateway-only hides coding/context/task
tools and retains enabled providers, Debate and connection self-restriction.

## 5. Agent Context & Skills

Call `context.bootstrap` before Full coding work and read its instructions/catalog.
Pass its receipt as `slnctrzContext`; load a needed skill with `skills.read` before requesting
its resources. Re-bootstrap after expiry, restart, policy or instruction changes.

Fresh installs seed code-review/debug-and-test only. Additional repository skills require
explicit project discovery or owner installation. See [Harness](HARNESS.md).

## 6. Tasks and Debates

`task.start` runs a bounded background command; get/wait/cancel operate on the creator's Runner.
`task.create` creates a workspace-visible logical task for another client to claim; it does not
execute a process. Task state is in-memory and clears on restart. Reconcile any previous
effects before recreating work.

Two-participant Debate history persists in SQLite. Instructions in a task or debate do not
grant permissions. The lifecycle ledger foundation does not make these tasks durable.
