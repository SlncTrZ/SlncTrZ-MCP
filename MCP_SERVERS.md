# MCP Server Management

Managing downstream MCP providers connected through SlncTrZ-MCP Gateway.

---

## 1. Provider Discovery

- Use the internal endpoint `server/discover` to scan and detect available providers across the system.
- Downstream providers (AutoCAD, SolidWorks, KiCAD, CyberBrain) run in isolated child processes.

---

## 2. Credentials & Safe Rotation

- Provider secrets are isolated in `<stateRoot>/mcp/credentials/`.
- During key updates: Credential rotation must activate the new credential before retiring older credentials to guarantee uninterrupted AI operations.
