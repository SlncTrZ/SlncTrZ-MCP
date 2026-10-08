# Security Policy

Current gateway security boundaries; see [Threat Model](docs/THREAT_MODEL.md) for limitations.

## 1. Core Security Invariants

1. **Explicit Boundaries:** Autonomous authority matches the gateway OS user. Restricted
   file tools additionally enforce Paths and command execution uses catalog authorization.
   A permitted shell/interpreter can exercise OS-account powers; Restricted is not an OS sandbox.
2. **Secret Path Containment:** Restricted file tools protect sensitive names such as .ssh
   and .gnupg. This is not a containment guarantee for Autonomous tools or independent providers.
3. **Abuse Protection:** Owner-secret abuse budgets count failed authentication attempts, not successful Owner logins/approvals.
4. **Privilege Separation:** Task Runtime is not a second privilege path and coordination-task text cannot grant capabilities.
5. **Transactional Mutation:** Policy/provider/command authority mutation is transactional.
   Failed activation/rollback is surfaced; external service continuity is not guaranteed.
6. **Clean Termination:** Graceful gateway shutdown requests cleanup of owned child runners
   and closes stores/listeners. Forced kill, host failure and remote-provider effects need separate reconciliation.
7. **Profile Ceiling:** A fresh Gateway-only consent cannot be promoted to Full by refresh
   or Owner controls. Migration preserves existing finite grants rather than silently widening them.
8. **Publisher Integrity:** Ed25519 authenticates the manifest and its binary size/hash.
   Windows Authenticode signing and independently verified signing custody are separate claims.
9. **Data Minimization:** Usage contains numeric telemetry. Context/task instructions remain
   untrusted guidance; do not place credentials in operation detail, docs or shared logs.

## 2. Reporting Vulnerabilities

Report security findings directly to Trương Công Định (SlncTrZ). Include a concrete reproduction,
affected version/build and expected/actual behavior without credentials or private state.
