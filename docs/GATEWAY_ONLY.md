# Gateway-Only Profile

Restricted connection profile for clients that only require downstream MCP tools or auxiliary services.

---

## 1. Profile Isolation

- Unlike Full connections (which expose file, bash, and coding tools), Gateway-only connections hide all coding and context surfaces.
- Enforces an immutable permission ceiling: a Gateway-only token cannot widen itself to Full.
- Refresh tokens remain active until revoked by the owner.
- Part of the unreleased advanced profile roadmap.

---

## 2. CLI Login Examples

- Pi Agent:
  ```bash
  pi mcp login slnctrz
  ```
- Codex:
  ```bash
  codex mcp login slnctrz
  ```
- OpenCode:
  ```bash
  opencode mcp auth slnctrz
  ```
