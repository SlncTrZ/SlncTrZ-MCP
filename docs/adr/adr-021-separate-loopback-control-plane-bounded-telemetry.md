# ADR-021 — Loopback Control Plane for Diagnostics and Revocation

## Status

Accepted, simplified.

## Decision

Keep a loopback-only control plane for bounded local administration that should not be exposed as model-facing MCP tools.

Supported responsibilities:

- status and current Paths/capability projection;
- audit and metrics diagnostics;
- OAuth client revocation;
- OAuth token revocation;
- explicit local policy reload diagnostics.

The control plane does not implement workspace/profile selection, proposal state machines, provider grants, or generic command execution.

## Security properties

- binds only to loopback IP literals;
- requires owner authentication;
- bounded JSON request bodies;
- stable non-secret response projections;
- no shell interpolation or arbitrary process execution.

Normal product configuration remains in the Owner Console through typed Paths, Commands, and MCP Server intents.
