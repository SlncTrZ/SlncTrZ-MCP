---
name: architectural-planning
description: Turn a cross-cutting requirement into a minimal, evidence-based architecture plan with explicit scope, contracts, state transitions, migration/rollback, milestones, and measurable acceptance criteria.
---

# Architectural Planning

Use this skill after repository reconnaissance when a change spans multiple components, persistence boundaries, protocols, or operational phases. Planning does not authorize implementation.

## Workflow

1. **Define scope and non-goals**
   - State the user-visible outcome and the exact problem being solved.
   - List non-goals so hardening ideas and future extensibility do not silently expand the task.

2. **Map the current architecture**
   - Name the existing entrypoints, components, state stores, interfaces, and ownership boundaries involved.
   - Reuse current abstractions unless the requirement demonstrates that they are insufficient.

3. **Define contracts and state transitions**
   - Specify inputs, outputs, errors, compatibility requirements, and observable behavior.
   - Model state transitions and failure/recovery paths when the feature mutates durable or external state.
   - Separate product logic from owner-configured authority or deployment policy.

4. **Choose the smallest viable design**
   - Compare alternatives only when there is a real design fork.
   - Prefer the design with fewer new concepts, fewer mutation points, and clearer verification.
   - Do not create generic frameworks, plugin layers, queues, caches, or shared packages for hypothetical future consumers.

5. **Plan migration and rollback**
   - Define compatibility during staged rollout.
   - Identify irreversible steps, downgrade constraints, and recovery behavior after partial failure.
   - Preserve existing data and supported clients unless the user explicitly accepts a breaking change.

6. **Decompose into milestones**
   - Each milestone should be independently reviewable and leave the repository in a valid state.
   - Name the likely files/components, dependencies on previous milestones, and the acceptance check for that milestone.

7. **Finish with an acceptance matrix**
   - Source/unit checks.
   - Integration or conformance checks.
   - Installed-artifact/live-runtime checks when source tests are insufficient.
   - Migration/rollback checks when state changes.

## Output

Produce a concise plan containing: current state, target behavior, chosen design, contracts/invariants, milestone order, migration/rollback, verification matrix, and unresolved decisions.

## Rules

- Ground the plan in repository evidence; do not design from filenames or assumptions alone.
- Surface incompatible requirements instead of averaging them.
- Keep optional hardening separate from required functional behavior.
- Do not implement, edit, commit, deploy, or migrate as part of planning unless separately authorized.
