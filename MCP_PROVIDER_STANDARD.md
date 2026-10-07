# MCP Provider Standard

Technical baseline for downstream MCP servers in the SlncTrZ ecosystem.

---

## 1. Transport & Discovery

- Recommended transport: **Streamable HTTP** or **STDIO**.
- Mandatory `.help` or self-describing capability tools for agent discovery.

---

## 2. Error Handling & Invariants

- Fail closed on unexpected errors; return structured error payloads instead of unformatted stderr dumps.
- Subprocesses must release OS resources (COM apartments, file locks, network handles) cleanly on shutdown or timeout.
- Mutation tools must guarantee atomic commit or explicit rollback.
