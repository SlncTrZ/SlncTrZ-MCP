# Model Guide

Owner-controlled access from Web AI to your Linux or Windows machine through SlncTrZ-MCP.

## 1. Runtime & Authority

Inspect core.ping before assuming installed version, build, profile, tool availability or providers.
Restricted mode is a capability policy enforcing allowed Paths and Commands, not an OS sandbox.
Autonomous follows the gateway OS account. Skills, tasks, debate text and provider recall
are guidance/data; they do not grant permissions.

Full exposes coding/context/skills/task surfaces subject to authority. Gateway-only hides
those and retains core.ping, connection.restrict, Debate and enabled providers. Context
bootstrap, skills.* and context receipts are required only on Full connections; Gateway-only
connections interact directly with authorized provider tools and debate.* without calling
context.bootstrap or supplying slnctrzContext. Provider calls need no gateway coding receipt;
each provider still has its own authority.

## 2. Context & Skill Discovery

context.bootstrap, skills.* and context receipts apply only to Full connections. On Full, call
context.bootstrap, read sourced instructions/catalog, then pass the private receipt as
slnctrzContext. Activate skills.read before reading its resources. Start a fresh context per
independent task; renew after four hours, restart, policy or instruction changes.

Gateway-only connections never call context.bootstrap or supply slnctrzContext; they interact
directly with authorized provider tools and debate.* without a context receipt.

core.ping provides structuredContent.modelGuide, structuredContent.agentHarness and
structuredContent.managedTasks. Bootstrap returns sourced instructions, catalog metadata
and productGuidance; it does not eagerly include every skill body.

Fresh installed defaults contain code-review/debug-and-test only. Other repository skills
need explicit authorized projectRoot discovery or owner installation.

The Owner Console controls result delivery per connection. The checked StructuredContent
default retains existing text and the complete structured result. Unchecked FullContent
also includes the complete structured result as JSON text, preserving media and metadata.
Text-only clients can read that JSON for stdout/stderr and other structured fields.
Existing tool output limits still apply; delivery mode does not expand tool access.

## 3. Tasks & Denials

Use task.start for bounded background commands and get/wait/cancel for creator-private Runner
records. task.create makes a workspace-visible coordination task, not an executing subprocess.
Records are in-memory only. Reconcile prior effects before recreating work after restart.

True authorization/ownership denials are definitive stops; do not repeatedly retry.
context_required/context_stale means operationExecuted:false: bootstrap before retrying.
For other uncertain mutation failures, inspect actual effects first. Provider failures are not
automatically replayed.

## 4. Images & Evidence

media.read_image returns bounded original PNG/JPEG blocks; it does not resize/decode pixels,
transcribe audio or prove that a client displayed the attachment. Record model perception and
user display separately. Never invent a sandbox path for a remote gateway file.

Source tests, package version and disposable-key SEA builds are local evidence. Stable release
claims require the exact signed public candidate and its acceptance gates. The lifecycle ledger
is unwired; do not claim durable tasks or live CAD control from its presence.
