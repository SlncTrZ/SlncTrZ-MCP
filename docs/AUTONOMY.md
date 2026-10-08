# Autonomy Levels

SlncTrZ-MCP provides two operating modes to fit different environments.

---

## 1. Restricted Mode

- Recommended for shared or work-managed environments.
- File operations are limited to configured `Paths`.
- Execution is limited to approved executables in `command.json`.
- Restricted file tools deny protected secret paths by default.
- A catalog-authorized shell/interpreter still has the gateway OS account's permissions.
  Restricted is a capability policy, not an OS sandbox; catalog entries do not make arbitrary scripts safe.

---

## 2. Autonomous Mode

- Designed for personal developer workstations and trusted automation nodes.
- Authority directly matches the operating-system user running the gateway:
  `model authority ≈ gateway process authority ≈ OS user authority`
- Files and commands accessible to that user are permitted without per-action approval prompts.
- Background execution via `task.start` inherits this authority.
- The gateway does not request per-action approval in this mode; the agent must still follow
  user authorization and its own approval rules. No UAC/sudo elevation is granted implicitly.

---

## 3. Coordination Scope

- Logical coordination tools (tasks, claims, releases) organize work and do not widen or alter the active autonomy mode.

Full/Gateway-only is a separate connection surface: Gateway-only hides gateway coding tools
but does not sandbox providers or the client's own tools. See [Gateway-only](GATEWAY_ONLY.md)
and [Threat Model](THREAT_MODEL.md).
