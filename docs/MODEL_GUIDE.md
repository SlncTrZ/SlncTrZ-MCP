# SlncTrZ-MCP Gateway — Model Guide

> This guide is **for the AI model** connected to a SlncTrZ-MCP gateway. After connect, call `core.ping` first. In a source checkout, `core.ping` points to `docs/MODEL_GUIDE.md`; in a standalone SEA, the same guide is embedded and returned through `structuredContent.modelGuide`. The owner configures the gateway through the **Owner Console** (`/owner`), not through model-facing admin tools.

---

## 1. What this gateway is

SlncTrZ-MCP is a **capability gateway**. It exposes a fixed set of core tools to authenticated
AI clients, and lets the owner expose **extra capabilities** without you ever self-granting them.

There are **four** normal, owner-configurable concepts:

| Concept         | File                                     | Meaning                                                                             |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **Autonomy**    | `policy.json` (`authorityMode`)          | `restricted` or `autonomous`; defines how much OS-user authority the model may use. |
| **Paths**       | `policy.json` (`paths[]`)                | Restricted-mode roots and default working context.                                  |
| **Commands**    | `command.json` (`shell.allowlist.added`) | Executables `core.exec` may run in restricted mode.                                 |
| **MCP Servers** | `mcp/providers.json`                     | Enabled provider tools exposed to you.                                              |

---

## 2. Your tools

| Tool          | Need      | Notes                                                                                            |
| ------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `core.ping`   | —         | Liveness + workspace capabilities/paths + doc/config pointers. **Run it first.**                 |
| `core.read`   | read cap  | Read a UTF-8 file inside an authorized Path.                                                     |
| `core.search` | read cap  | Find **files & directories** in a Path, **case-insensitive**; `*`/`?` glob.                      |
| `core.write`  | write cap | Write a file (applies by default; `dryRun:true` = preview).                                      |
| `core.edit`   | write cap | Exact-match edit (applies by default; `dryRun:true` = preview).                                  |
| `core.exec`   | exec cap  | Run platform-native commands. Restricted uses `command.json`; autonomous uses OS-user authority. |

**Capability presence** derives automatically from config + platform:

```
restricted: Paths → core.read / core.search / core.write / core.edit
restricted: Paths + command.json → core.exec
autonomous: all core tools → gateway OS-user authority
```

There are **no** `owner.*` tools. You cannot self-configure.

---

## 3. Autonomy levels

SlncTrZ has two owner-selected autonomy levels:

| Level          | Filesystem                                             | Execution                                                                              | Intended use                                                      |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Restricted** | Core file tools normally stay inside configured Paths. | `command.json` selects which executables may start; cwd stays inside configured Paths. | Shared machines, cautious deployments, explicit capability setup. |
| **Autonomous** | Any path the gateway OS user can access.               | Any executable the gateway OS user can resolve/run; cwd may be outside Paths.          | Personal development and trusted automation hosts.                |

Restricted mode is a capability policy, **not a complete OS sandbox**. If the owner allows a general-purpose shell or interpreter such as PowerShell, `cmd`, Bash, Python or Node, that child process may itself use the filesystem/process rights of the gateway OS account. This is intentional: the owner controls how powerful the command set is.

Autonomous mode follows one simple rule:

```text
model authority ≈ gateway process authority ≈ OS user authority
```

SlncTrZ does not silently elevate privileges. If the gateway runs unelevated, the model is unelevated. If the owner deliberately runs it elevated, the model receives that elevated process authority.

---

## 4. What you can do / cannot do

In **restricted** mode, use configured Paths for file tools and commands authorized by `command.json`.

In **autonomous** mode, you may operate outside Paths whenever the task requires it, using the same authority as the gateway process. Do not ask for per-operation permission merely because a target is outside the current workspace.

Gateway configuration remains an owner concern. There are no model-facing `owner.*` tools; owner configuration is managed through `/owner` or local managed state.

---

## 5. Config file locations

| File                 | Role                                        | Typically at                     |
| -------------------- | ------------------------------------------- | -------------------------------- |
| `policy.json`        | `schemaVersion`, `paths[]`, `authorityMode` | `<stateRoot>/policy.json`        |
| `command.json`       | exec allowlist                              | `<stateRoot>/command.json`       |
| `mcp/providers.json` | enabled MCP providers                       | `<stateRoot>/mcp/providers.json` |
| `audit.sqlite3`      | durable metadata-only audit journal         | `<stateRoot>/audit.sqlite3`      |

`stateRoot` is set by the owner (default `~/.slnctrz-mcp` or a systemd state dir). `core.ping`
returns the exact paths under `config`. Treat these as **owner-managed configuration**. Restricted mode normally cannot reach them through core file tools; autonomous mode may have OS-level access, but must not change owner configuration unless the owner explicitly asks for that configuration change.

---

## 6. If the owner asks you to configure the gateway

Gateway configuration is owner-controlled. Correct behavior:

1. Prefer the **Owner Console** (`/owner` — URL returned by `core.ping`) for Autonomy, Paths, Commands and MCP Server changes.
2. In restricted mode, ask the owner to make the required change because config is normally outside the reachable Paths.
3. In autonomous mode, do not silently self-grant or change owner policy. Only modify managed configuration when the owner explicitly instructs you to make that configuration change.
4. After configuration changes, re-run `core.ping` (or `tools/list`) to confirm the active state before continuing.

Do **not** guess, fabricate config, or ask the owner to grant you admin tools.

---

## 7. Security & rules

- **Fail closed:** unknown/invalid state is denied. Never assume a Path/command is authorized.
- **Secrets:** never expose credentials; the gateway isolates MCP credentials and never returns them.
- **Containment:** restricted file operations are canonical-root-checked; autonomous mode deliberately follows OS-user authority instead of workspace containment.
- **Audit:** core tool calls, auth/policy events and control-plane actions are journaled as metadata-only; the bounded in-memory journal is also persisted to `<stateRoot>/audit.sqlite3`. Durable retention defaults to the newest 250,000 events. Do not put secrets in tool args.
- **Cross-platform exec:** `core.exec` runs natively on Windows and POSIX. Restricted mode resolves commands through the configured catalog; autonomous mode resolves through the OS-user environment. Time/output/process-cleanup guards remain active.

---

## 8. Owner Console quick reference

- Owner signs in with a passphrase (`/owner`).
- The UI should show the active **Autonomy level** prominently alongside **Paths**, **Commands**, and **MCP Servers**.
- Add Path / Add Command / Add MCP are direct typed actions; they persist and activate immediately.
- For MCP Server field examples (Remote URL, local executable, Node script, Python script), read `MCP_SERVERS.md`.

When the owner tells you to use a capability that isn't there yet, this is the normal place to configure it. See `docs/AUTONOMY.md` before choosing an autonomy level.

---

## 9. Workspace instructions and editable docs

- Follow the owner's workspace instructions when an `AGENTS.md` or equivalent project instruction file is inside an authorized Path.
- Do not treat the public root `README.md` as a model persona/configuration store; it is the human product entry point.
- Edit project documentation only when the owner explicitly asks for that documentation change and the file is within current authority.
- `policy.json` / `command.json` / `mcp/providers.json` are owner-managed. Restricted mode normally cannot reach them; autonomous mode may have OS-level access but should change them only on explicit owner instruction.

---

## 10. Search & timeouts

- `core.search` matches **files AND directories** and is **case-insensitive**; `*`/`?` are glob wildcards.
- If a result reports `truncated: true`, the scan hit a cap — it may **not** be exhaustive. Try a narrower
  pattern, a shallower path, or fall back to `core.exec` (e.g. `find /path -iname ...`).
- You don't need to know the exact casing — try several spellings/cases of a name.
- Timeouts: `core.exec` defaults to **30 min** with a **2 h hard ceiling**; `core.search` **5 min**; read/write/edit **30s**. `core.exec` may request a lower/explicit bounded timeout per call. Early results return immediately.
- **To read a file you can't name exactly:** don't guess an absolute path. Use `core.search` with a
  fragment first (case-insensitive, matches files & dirs), then `core.read` the returned path:
  `core.search "project-plan"` → `core.read /workspace/docs/project-plan.md`.
  If a result is `truncated`, refine the pattern instead of assuming absence.
