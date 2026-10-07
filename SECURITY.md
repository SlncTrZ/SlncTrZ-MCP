# Security Policy

Security design and incident reporting for SlncTrZ-MCP Gateway.

---

## 1. Core Security Invariants

1. **Explicit Boundaries**: AI capabilities match the gateway OS user; no silent privilege escalation.
2. **Secret Path Containment**: Sensitive system credentials (`.ssh`, `.gnupg`, private tokens) are protected in Restricted mode.
3. **Abuse Protection**: Owner-secret abuse budgets count failed authentication attempts, not successful Owner logins/approvals to block brute-force attacks.
4. **Privilege Separation**: Task Runtime is not a second privilege path and coordination-task text cannot grant capabilities.
5. **Transactional Mutation**: Policy/provider/command authority mutation is transactional, preventing partial configuration drift.
6. **Clean Termination**: Graceful gateway shutdown terminates child processes cleanly before exit.

---

## 2. Reporting Vulnerabilities

Report security findings directly to Trương Công Định (SlncTrZ).
