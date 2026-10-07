# SlncTrZ-MCP Architecture

A single gateway providing owner-controlled access between Web AI and local development machines (Linux/Windows).

---

## 1. System Overview

SlncTrZ-MCP exposes files, commands, skills, tasks, and downstream MCP providers through a single authenticated port (`:3100`).

```text
Client (Web AI / IDE / Subagent)
  │ (OAuth 2.1 PKCE)
  ▼
SlncTrZ-MCP Gateway (:3100)
  ├─ Policy Engine (Paths, Commands, Providers, Autonomy)
  ├─ Context Service (context.bootstrap → Product Agent Harness + Skills)
  ├─ Core Tools (core.read, core.search, core.write, core.edit, core.exec)
  ├─ Managed Task Runtime (task.start, task.create, coordination)
  ├─ Debate Engine (durable SQLite multi-agent debate)
  └─ Provider Supervisor (isolated downstream MCP processes)
```

The owner controls four core boundaries:
- **Autonomy**: Restricted (catalog-enforced) or Autonomous (OS-user level).
- **Paths**: Allowed filesystem roots for read/write.
- **Commands**: Allowed binaries in Restricted mode (`command.json`).
- **MCP Servers**: Registered downstream providers.

---

## 2. Core Components

### Core Tools
- `core.ping`: Connection verification and profile inspection.
- `core.read`, `core.search`: Scoped file inspection.
- `core.write`, `core.edit`: Exact-match, atomic file updates.
- `core.exec`: Command execution governed by autonomy settings.

### Coding Context & Skills
- `context.bootstrap`: Session initialization providing the Product Agent Harness and skills catalog.
- `skills.read`: Progressive disclosure of individual skills on demand.

### Managed Task Runtime
- Manages background runners and multi-agent coordination.
- `task.start`: Launches background processes with timeouts and output bounds.
- `task.create`: Creates coordination milestones between agents.
- Runtime state is kept `in-memory` and clears cleanly on shutdown.

### Extension & Provider Supervisor
- Manages external MCP providers (AutoCAD, SolidWorks, KiCAD, CyberBrain).
- Runs providers in isolated processes with per-call timeouts.
- Failures are bounded: recurrent `session_invalid` incidents are additionally bounded by a rolling incident budget.
- Credential rotation stages a new opaque ref to avoid downtime or leaked credentials.

### Operations & Lifecycle
- Web Owner console at `http://127.0.0.1:3100/owner`.
- Graceful application shutdown: Handles SIGTERM/SIGINT, terminates child runners cleanly, flushes persistent SQLite state.
