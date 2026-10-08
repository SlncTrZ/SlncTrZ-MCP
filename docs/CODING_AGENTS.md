# Coding Agents Integration

Choose the profile before integrating a coding client. [Gateway-only](GATEWAY_ONLY.md)
keeps the client's own filesystem/harness; Full adds gateway coding/context/task tools.

## 1. Connection & Protocol

Connect to the configured HTTP /mcp endpoint and complete OAuth PKCE. Cloud clients need
reachable HTTPS. Each client's MCP configuration and login syntax are client-version facts;
the example flows do not establish release-specific compatibility.

## 2. Session Context & Receipts

For Full ordinary coding calls, including reads, search, mutations and task tools:

1. Call context.bootstrap and read its instructions, diagnostics and catalog.
2. Keep the returned contextToken private; pass it as `slnctrzContext`.
3. Alternatively, put the same value in MCP request `_meta["org.slnctrz/contextToken"]`.
   Supplying conflicting argument/metadata receipts is rejected.
4. Bootstrap again on context_required/context_stale; those rejected operations were not executed.
5. Release with context.close after work.

Receipts do not widen capability authority. They expire after four hours and reset on gateway
restart. core.ping can inspect identity/profile without a context; it exposes modelGuide,
agentHarness and managedTasks in structuredContent. Bootstrap delivers sourced instructions
and catalog metadata, not all skill bodies. Gateway-only providers need no gateway receipt.

## 3. Skills Loading

Browse skills.list, activate a selected skill with skills.read, then read its referenced
resources on demand. Discovery uses the owner global harness and an optional authorized
projectRoot; it does not implicitly discover a coding client's local project.

Fresh installed harnesses contain code-review/debug-and-test only. Additional repository
skills require project discovery or explicit owner installation. See [Harness](HARNESS.md).
