# Release Acceptance Criteria

Verification requirements for SlncTrZ-MCP releases.

---

## 1. Core Acceptance Gates

A release candidate is approved only when:

- Full test suite passes (`npm test`).
- Documentation and contract validation clean (`npm run docs:check`).
- Standalone SEA binary boots on clean environments without external Node dependencies.

---

## 2. Release Signing & CI Integrity

1. The CI signing pipeline runs only when the `release-signing` Environment exists **before** the workflow run.
2. Binary SHA-256 matches the signed release manifest.
3. No unsigned artifacts or untrusted commits are promoted.

---

## 3. State Management & Migrations

When updating configurations or rotating provider credentials:

- State transitions follow the sequence: OLD -> committed -> active runtime NEW.
- Support both official legacy + modern-only provider formats seamlessly.
- Concurrent resource claims must resolve to exactly one winner.

---

## 3. Managed Task Runtime release acceptance

- Background task execution via `task.start` and coordination via `task.create` operate reliably.
- `context.bootstrap` initializes the agent harness and skills index.
- `skills.read` delivers skill bodies without leaking unauthorized paths.
- Shutdown releases all child processes cleanly without orphaned runners.
