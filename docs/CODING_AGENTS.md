# Coding Agents Integration

Connecting AI coding agents (Claude Code, OpenCode, Pi, Codex) to SlncTrZ-MCP Gateway.

---

## 1. Connection & Protocol

- Connect via standard MCP over HTTP at `:3100/mcp`.
- Authenticate using OAuth 2.1 PKCE to acquire a bearer access token.

---

## 2. Session Context & Receipts

For mutation operations (`core.write`, `core.edit`, `core.exec`):

1. Initialize the session using `context.bootstrap`.
2. The gateway returns a verified context token under `org.slnctrz/contextToken`.
3. Pass this context receipt in subsequent coding tool requests to maintain valid authorization.

---

## 3. Skills Loading

- Browse available capabilities via `skills.list`.
- Read individual skill instructions on-demand via `skills.read`.
