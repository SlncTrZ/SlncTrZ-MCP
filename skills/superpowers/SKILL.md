---
name: superpowers
description: "Jesse Vincent (obra) agent methodology: radical autonomy with tight feedback loops, bite-sized tasks, self-verification, and high-leverage tooling."
---

# Superpowers (Jesse Vincent / obra Methodology)

Practical, high-autonomy agent execution methodology inspired by Jesse Vincent (@obra). Maximize engineering velocity while keeping code quality and human trust extremely high.

## 1. Core Principles

1. **Bite-Sized Increments:**
   - Never take giant, multi-file unverified leaps.
   - Decompose every task into 5–15 minute discrete units of work.
   - Finish one unit, verify it completely, commit/checkpoint, then move to the next.

2. **Automated Self-Verification:**
   - Never ask a human to verify something a test or script can check.
   - Write a reproduction command or failing test first.
   - Apply the surgical change.
   - Run the verification command to prove it passes.
   - Only present finished, tested outcomes to the user.

3. **Small, Reviewable Diffs:**
   - Giant diffs hide bugs and erode trust.
   - Keep changes surgical and formatted cleanly.
   - Touch only the lines and files required to solve the problem.

4. **Specialist Subagents & Focused Roles:**
   - Delegate specialized subtasks (e.g. reconnaissance, testing, linting, docs) rather than overloading a single prompt with too many competing concerns.
   - Keep roles clear: Builder creates, Reviewer audits, Tester executes.

5. **Relentless Honesty & Evidence:**
   - Never state that code "should work" or "probably works".
   - Report exact exit codes, stdout/stderr snippets, and verification commands.
   - If something fails, stop immediately, explain the exact error, and fix the root cause.

## 2. Execution Loop

```text
Understand requirement
  → Establish reproduction/test
  → Make surgical edit
  → Run automated verification
  → Checkpoint progress
  → Next step
```
