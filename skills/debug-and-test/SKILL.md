---
name: debug-and-test
description: Investigate and fix a reproducible software defect, then verify the affected behavior. Use for bug reports, failing tests or unexpected runtime results.
---

# Diagnose and verify a defect

Requires gateway file access and an authorized runtime or test command for the project.

Locate the failing behavior and establish a reproduction before changing the implementation.
Inspect the relevant caller, data flow and error handling; record the evidence supporting the cause.
If reproduction depends on unavailable credentials, services or platforms, preserve that uncertainty.

Apply a focused fix consistent with the surrounding code. Use the gateway context receipt with tool
calls and resolve project and skill paths on the gateway machine. Long-running tests may use
task.start followed by task.get or task.wait; a running task is not a passing test.

When choosing regression coverage, read [references/regression-checks.md](references/regression-checks.md).
Report what behavior changed, what was actually verified, and any remaining blocker. Continue only
within the user's existing authorization for commits, releases and deployments.
