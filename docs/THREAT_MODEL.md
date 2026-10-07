# Threat Model

Security boundaries and threat mitigation for SlncTrZ-MCP Gateway.

---

## 1. Security Model

SlncTrZ-MCP exposes workstation capabilities to authenticated AI clients without pretending that all operating modes are sandboxes:

- **Restricted**: Strict path containment and command catalog whitelist.
- **Autonomous**: Matches the OS account running the gateway. It does not elevate privileges.

---

## 2. Threats & Mitigations

### Filesystem & Secrets

- **Threat:** AI reading credentials (`.ssh`, `.gnupg`, private tokens).
- **Mitigation:** In Restricted mode, sensitive paths are denied by default. Writes use atomic swap to prevent partial corruption.

### Command Execution

- **Threat:** Arbitrary code execution or system tampering.
- **Mitigation:** Restricted mode only allows binaries listed in `command.json`. Autonomous mode inherits the OS user's permissions without silent UAC/sudo elevation.

### Managed task requirements

- **Task-state exhaustion:** Background tasks enforce strict concurrency limits, timeouts, and output buffer caps to prevent resource exhaustion.
- Child tasks cannot widen gateway permissions.

### Downstream Providers & Secrets

- **Threat:** Compromised downstream MCP server or token leak.
- **Mitigation:** Providers run in isolated processes. Credential rotation rollback guarantees that failed credential rotation falls back to the active configuration without service disruption.

### Supply Chain & Releases

- **Ed25519 publisher signature:** Standalone binaries (SEA) are signed with Ed25519 keys generated in isolated CI environments.
- **Release signing-key misuse:** Signing keys are protected within dedicated GitHub Environments, preventing untrusted workflow tampering.
