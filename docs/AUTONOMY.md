# Autonomy Levels

SlncTrZ-MCP provides two operating modes to fit different environments.

---

## 1. Restricted Mode

- Recommended for shared or work-managed environments.
- File operations are limited to configured `Paths`.
- Execution is limited to approved executables in `command.json`.
- Secret paths are denied by default.

---

## 2. Autonomous Mode

- Designed for personal developer workstations and trusted automation nodes.
- Authority directly matches the operating-system user running the gateway:
  `model authority ≈ gateway process authority ≈ OS user authority`
- Files and commands accessible to that user are permitted without per-action approval prompts.
- Background execution via `task.start` inherits this authority.

---

## 3. Coordination Scope

- Logical coordination tools (tasks, claims, releases) organize work and do not widen or alter the active autonomy mode.
