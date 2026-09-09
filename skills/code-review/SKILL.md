---
name: code-review
description: Review a code change for concrete bugs, regressions and missing verification. Use when the user requests a review or an assessment of a patch before integration.
---

# Review a change

Requires gateway file access and Git execution for the target repository.

Establish the intended behavior and comparison base from the user's request and repository state.
Inspect the diff, then trace affected callers and error paths before deciding that something is a bug.
Distinguish existing defects from regressions introduced by the change.

Use the gateway's current context receipt for calls. Repository paths refer to the gateway machine.
Run focused checks through authorized execution tools when they resolve a concrete uncertainty.
Treat an unavailable dependency or platform as a verification limit, not a successful check.

Report actionable findings with a file location, the triggering condition, the resulting failure and
its practical impact. State uncertainty when evidence is incomplete. If no findings are supported,
say so and identify material verification gaps. Review authorization alone does not authorize edits,
commits, publication or deployment.
