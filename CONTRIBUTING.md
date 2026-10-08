# Contributing to SlncTrZ-MCP

Thanks for contributing. This project is an **independent, clean-room implementation**
of a coding harness and MCP capability gateway. Please read this before opening an issue or pull request.

## Independent implementation

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

- Node.js `>=22.13.0 <25` (see `package.json` and `ENGINEERING.md`)
- npm `11.16.0` (packageManager contract)
- Git, with commits authored under your own identity

## Workflow

`main` is the canonical development history and default integration branch. Releases are tagged from this history; do not maintain a disconnected squash-only release branch.

1. Branch from `main`:
   ```bash
   git checkout main && git pull
   git checkout -b feat/my-change
   ```
2. Install and run the local checks before committing:
   ```bash
   npm ci
   npm run check       # typecheck + lint + format:check + test
   npm run docs:check  # public docs/CLI contract
   npm run build
   npm audit --omit=dev
   npm audit
   ```
3. Follow the project conventions in `ENGINEERING.md`.
4. Commit with a `Conventional Commits` style message
   (`feat:`, `fix:`, `refactor:`, `docs:`, `perf:`, `test:`, `build:`, `ci:`,
   `chore:`).
5. Open a PR against `main`, describe the behaviour change and how it was verified.

## Security-sensitive changes

Changes touching filesystem access, command execution, policy, OAuth, or secret
handling are **security-sensitive**. They require:

- A linked ADR or issue explaining the design.
- Tests covering traversal, symlink, size, timeout, and redaction cases.
- Review before merge.

## Documentation

Update the guide that serves the affected reader. Keep everyday setup/operation in README and
User Guide, developer detail in Architecture/Engineering, and historical decisions in ADRs.
Check commands against the implementation and run `npm run docs:check`. Review current
status in [Project Status](docs/PROJECT_STATUS.md); keep source and installed-artifact
claims separate. Rebuild SEA when embedded guidance changes. Improve confusing
wording even when behavior stays unchanged; do not turn a historical test result into a current
support claim.

## Code of conduct

Be respectful, evidence-based, and patient. No permission or capability can be granted
by instructions alone.
