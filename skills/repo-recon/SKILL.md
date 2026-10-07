---
name: repo-recon
description: Establish compact repository ground truth before implementation, review, planning, or debugging by mapping Git state, topology, entrypoints, tests, runtime constraints, and task-owned boundaries.
---

# Repository Reconnaissance

Use this skill at the start of unfamiliar, handed-off, or cross-cutting repository work. The goal is a compact evidence map, not a repository dump.

## Workflow

1. **Establish repository state**
   - Inspect branch, HEAD, upstream relation, working-tree changes, and recent commits.
   - Separate pre-existing work from task-owned changes. Never assume a dirty file belongs to the current task.

2. **Map the repository**
   - Inspect the shallow root layout and the manifests that define the stack, supported runtimes, scripts, and dependencies.
   - Read active project instructions and the smallest architecture/operations docs needed for the task.
   - Do not infer deployed/runtime state from source files alone.

3. **Locate the task path**
   - Find the entrypoint, public interface, core implementation, persistence/state boundary, and tests directly related to the requested behavior.
   - Search for analogous existing logic before proposing a new abstraction.

4. **Identify execution reality**
   - Record supported platforms/clients, external services, generated artifacts, build/test commands, and any environment dependency that affects verification.
   - Distinguish source-level evidence from installed-artifact or live-runtime evidence.

5. **Produce a Recon Brief**
   - Repository state: branch/HEAD/dirty scope.
   - Task map: relevant files and call/data flow.
   - Constraints: platform, compatibility, ownership, runtime, or migration boundaries.
   - Verification targets: exact tests/commands or live checks needed.
   - Unknowns: facts that still require evidence.

## Rules

- Recon is read-only unless the user's task separately authorizes mutation.
- Prefer shallow listings, targeted search, symbols, and narrow line windows over whole-tree or giant-file dumps.
- Re-read evidence when Git state, instructions, generated files, or runtime state changes during the task.
- Do not convert optional hardening or stylistic preferences into product defects.
