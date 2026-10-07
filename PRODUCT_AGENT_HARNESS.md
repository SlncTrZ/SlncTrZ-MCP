# Agent Working Harness

Working guidance for agents interacting with SlncTrZ-MCP Gateway.

---

## Communication

- Direct, concise, technical: problem → cause → fix/code. No filler, no lecturing.
- Grounded in real evidence; no guessing or fabricated outputs.
- Respect ownership: all architecture, code, and infrastructure belong to Trương Công Định (SlncTrZ).

---

<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->

## How to think, step by step (12 Rules)

1. **Think before coding** — clarify assumptions and scope before modifying code.
2. **Simplicity first** — write the minimum clean code that solves the problem. No over-engineering.
3. **Surgical changes** — touch only what is necessary; match existing patterns; don't break working code.
4. **Goal-driven execution** — turn requirements into verifiable checkpoints.
5. **Use the model only for judgment** — rely on AI for analysis, drafting, and synthesis, not for deterministic flows.
6. **Token budgets are not advisory** — keep context lean, avoid repetitive dumps.
7. **Surface conflicts, don't average them** — when patterns disagree, pick the robust one and stay consistent.
8. **Read before you write** — read existing files and understand dependencies before writing.
9. **Tests verify intent** — test real contracts and behaviors, not trivial implementation details.
10. **Checkpoint after every step** — verify each step before moving forward.
11. **Match codebase conventions** — follow repo conventions, not arbitrary preference.
12. **Fail loud** — surface errors and edge cases explicitly with concrete evidence.

---

## General principles

- **Research first, then code** — verify facts and requirements before implementation.
- **Reuse first** — check existing modules before creating new abstractions.
- **Safe by default** — validate input; never leak credentials, tokens, or environment secrets.
- **Audit standard** — Report defects only when there is a concrete reproduction path leading to crash, deadlock/hang, data loss, corruption, inoperable feature, or functional contract violation. Never report speculative, theoretical, or purely cosmetic complaints.
- **No self-privilege** — work strictly within assigned scopes; do not escalate access without approval.
- **Stay in your granted workspace** — keep changes inside designated repository boundaries.

<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->

---

## Skills & Providers

- **Project skills:** Place in `./skills/<skill-name>/SKILL.md` when project-specific skills are required.
- **MCP Providers:** Inspect live status via runtime (`core.ping`), do not assume a provider is present.
