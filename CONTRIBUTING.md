# Contributing to SlncTrZ-MCP

Thanks for contributing. This project is an **independent, clean-room implementation**
of a Universal MCP Gateway. Please read this before opening an issue or pull request.

## Clean-room rule (PLAN §2.1)

- Do not copy source code, comments, documentation, UI text, naming conventions, or
  test fixtures from reference implementations (including `aki-mcp-sv` and research
  notes).
- Reference repositories and research notes live outside tracked source (excluded via
  `.gitignore`).
- Every production module must have clear provenance: a project requirement, a protocol
  requirement, or an independently recorded architecture decision.
- If you derived an idea from external material, attribute it in the commit message or
  the linked ADR; do not bring the text in verbatim.

## Prerequisites

- Node.js `>= 22` (see `ENGINEERING.md`)
- npm `11.x`
- Git, with commits signed and authored as `SlncTrZ`/your own identity

## Workflow

1. Branch from `master`:
   ```bash
   git checkout master && git pull
   git checkout -b feat/my-change
   ```
2. Install and run the local checks before committing:
   ```bash
   npm install
   npm run check   # typecheck + lint + format:check + test
   ```
3. Follow the project conventions in `ENGINEERING.md`.
4. Commit with a `Conventional Commits` style message
   (`feat:`, `fix:`, `refactor:`, `docs:`, `perf:`, `test:`, `build:`, `ci:`,
   `chore:`).
5. Open a PR against `master`, describe the behaviour change and how it was verified.

## Security-sensitive changes

Changes touching filesystem access, command execution, policy, OAuth, or secret
handling are **security-sensitive**. They require:

- A linked ADR or issue explaining the design.
- Tests covering traversal, symlink, size, timeout, and redaction cases.
- Review before merge.

## Documentation

Update `PLAN.md`/`ARCHITECTURE.md`/`README.md` only when behaviour or scope actually
changes. Keep documentation in sync with behaviour (definition of done, PLAN §9).

## Code of conduct

Be respectful, evidence-based, and patient. No permission or capability can be granted
by instructions alone (PLAN §2.3).
