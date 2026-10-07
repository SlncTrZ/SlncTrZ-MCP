---
name: context-slicing
description: Keep large-repository work accurate by selecting the smallest evidence slice that answers the current question while preserving callers, contracts, tests, and invalidation signals.
---

# Context Slicing

Use this skill when a repository, diff, or investigation is too large to load safely as one context. The objective is minimal sufficient evidence, not minimal token count at any cost.

## Workflow

1. **State the current question**
   - Define the exact behavior, decision, or uncertainty being resolved now.
   - Do not slice before the question is explicit.

2. **Build the core slice**
   - Read the public interface or type first.
   - Trace the active path from trigger → handler/service → state/persistence/output.
   - Include the nearest tests that encode the expected contract.

3. **Add adjacent evidence only when needed**
   - Direct callers and callees.
   - Shared helpers whose semantics affect the path.
   - Migration/compatibility code when state or API shape changes.
   - Runtime/configuration evidence when source alone cannot answer the question.

4. **Track deferred context**
   - Mark unrelated siblings, broad docs, generated output, and historical code as deferred rather than loading them preemptively.
   - Pull deferred context only when a concrete dependency or contradiction appears.

5. **Maintain a Slice Manifest**
   - Question being answered.
   - Core files/symbols and why each is included.
   - Adjacent files loaded later and the trigger for loading them.
   - Known assumptions and unresolved gaps.
   - Verification evidence already collected.

## Invalidation Rules

Re-read a slice when any of these change: Git revision or working-tree content, project instructions, generated artifacts used by the task, runtime/configuration state, or an upstream interface relied on by the slice.

## Rules

- Prefer targeted search, symbol/call-site lookup, and narrow line windows over raw directory or file dumps.
- Do not trust remembered file content after concurrent edits or a stale context receipt.
- Do not omit a caller, error path, or test merely to save tokens when it materially changes correctness.
- Slicing guides what to read; it does not authorize writes or execution.
