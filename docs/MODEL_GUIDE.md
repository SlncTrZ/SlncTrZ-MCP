# Model Guide

Owner-controlled access from Web AI to your Linux or Windows machine via SlncTrZ-MCP Gateway.

---

## 1. Operating Rules for Models

When connected to this gateway:

- Be concise, technical, and accurate. Skip conversational filler.
- Check connection health and profile using `core.ping`.
- Respect policy: Restricted mode is a capability policy enforcing allowed Paths and Commands.

---

## 2. Context & Skill Discovery

Before executing complex tasks:

1. Call `context.bootstrap` to load working guidance and the skills index.
2. Call `skills.read` only when a specific skill body is needed.
3. Key structured outputs:
   - `structuredContent.modelGuide`: Constraints and execution boundaries.
   - `structuredContent.agentHarness`: Core engineering and thinking rules.
   - `structuredContent.managedTasks`: Active tasks.

---

## 3. Tasks & Denials

- Use `task.start` for long-running background processes.
- Use `task.create` for multi-step coordination across agents.
- Runtime state is in-memory only and resets on restart.
- True authorization/ownership denials are definitive stops; do not retry blocked calls repeatedly.
