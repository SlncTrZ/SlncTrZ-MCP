# Architecture Decision Records

This directory records **significant** architecture decisions for SlncTrZ-MCP.

An ADR is written when a decision is non-obvious, hard to reverse, or affects multiple
components. Routine choices belong in code comments or commit messages, not here.

## Register

| ID      | Title                                                               | Status   |
| ------- | ------------------------------------------------------------------- | -------- |
| ADR-001 | TypeScript and Node.js for the gateway core                         | Accepted |
| ADR-002 | Apache-2.0 project license                                          | Accepted |
| ADR-003 | Trusted kernel runs in-process                                      | Accepted |
| ADR-004 | Third-party MCP servers run in isolated child processes by default  | Accepted |
| ADR-005 | Policy Engine is the single source of authorization truth           | Accepted |
| ADR-006 | Support both modern stateless MCP and legacy session-based MCP      | Proposed |
| ADR-007 | Tool registry uses canonical names independent of runtime topology  | Accepted |
| ADR-008 | Standalone packaging is separated from runtime architecture         | Accepted |
| ADR-009 | Project instructions are explicit context, not a security mechanism | Accepted |
| ADR-010 | No home-directory access by default                                 | Accepted |

## How to add an ADR

1. Copy `_template.md` to the next number, e.g. `adr-011-title.md`.
2. Fill in Status, Context, Decision, Consequences.
3. Add the row to the register above.
4. Keep it short and decision-focused.

> ADRs are tracked alongside the code. For the full rationale behind the accepted
> decisions, see PLAN §5 (Architecture decision records) and ARCHITECTURE.md.
