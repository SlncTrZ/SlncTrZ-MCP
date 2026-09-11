# Coding harness

SlncTrZ-MCP 0.3.0 supplies a coding environment through MCP: global instructions, Agent Skills,
file and command tools, managed tasks, images and owner-managed MCP providers. Any compatible
coding agent or chat client can use the same endpoint. The connected host still owns its model,
conversation, context window and user interface.

## Global configuration

The default editable configuration is:

| File or directory                               | Purpose                                     |
| ----------------------------------------------- | ------------------------------------------- |
| `<stateRoot>/harness/AGENTS.md`                 | Global preferences for work across projects |
| `<stateRoot>/harness/skills/<name>/SKILL.md`    | Discoverable Agent Skills                   |
| `<stateRoot>/harness/skills/<name>/references/` | Optional reference files                    |
| `<stateRoot>/harness/skills/<name>/scripts/`    | Optional executable helpers                 |
| `<stateRoot>/harness/skills/<name>/assets/`     | Optional assets                             |

Setup prints the exact paths. `slnctrz-mcp config show --json` and `core.ping` also expose them.
Source starts, fresh installs and upgrades from earlier versions initialize this layout. Setup
seeds `code-review` and `debug-and-test` once. Existing files are never overwritten; intentional
skill deletions remain deleted on subsequent starts. The `.initialized` marker records seeding,
not whether a model has read anything. Global files are separate from versioned release binaries.

An owner may set `SLNCTRZ_HARNESS_ROOT` to an absolute directory in `gateway.env` or the source
runtime environment. That directory must be accessible to the runtime OS account. This changes
the discovery root, not the general filesystem Paths or command authority. A custom root outside
managed state must be backed up separately and is not deleted by uninstall's managed-state purge.

There is no need to add AGENTS.md to every repository. `context.bootstrap({})` loads global
configuration only. The gateway does not scan unrelated home directories or infer a remote
project from the client's local current directory.

## Optional project context

Call `context.bootstrap({"projectRoot":"/absolute/gateway/project"})` to additionally read that
project's root `AGENTS.md` and discover `.agents/skills/*/SKILL.md` and `skills/*/SKILL.md`.
The project must be readable under current authority. Restricted documentation-only read scopes
do not authorize project discovery. A missing project AGENTS.md is valid.

Global instructions precede project instructions. They retain their source labels; surface
conflicts rather than treating textual guidance as a policy grant. Project skills override global
skills with the same name. Within the project, `skills/` overrides `.agents/skills/`; collisions
appear in diagnostics. This release does not implement nested directory AGENTS.md inheritance.
Start another context when switching project scope. A global-only context can work across Paths.

## Required bootstrap

1. Call `context.bootstrap`; read its product/global instructions and skill catalog.
2. Retain `contextToken` and pass it as `slnctrzContext` on subsequent gateway tool calls.
3. Activate a relevant or explicitly requested skill with `skills.read({name, slnctrzContext})`.
4. Read a referenced text resource with `skills.read({name, resource, slnctrzContext})` only when needed.
5. Close the context with `context.close({slnctrzContext})` when the task is finished.

For example, tool arguments to read a project file after bootstrap are:

```json
{
  "path": "/work/project/package.json",
  "slnctrzContext": "<contextToken from context.bootstrap>"
}
```

`core.ping` remains available for diagnostics. `context.bootstrap` creates a receipt;
`context.close` releases one. `task.cancel` remains available without bootstrap so an invalid
configuration cannot prevent cancellation of an already-running task. Its normal ownership and
authorization checks still apply. Other core, image, task and provider tool calls require a valid
receipt in the product runtime.

Receipts are opaque, in-memory, bound to authenticated client, workspace and policy version,
and expire after four hours. They do not survive a gateway restart. Separate conversations/tasks
should bootstrap separately, including when they share one OAuth client. The gateway cannot
infer ChatGPT conversation boundaries or prove that a model retained/understood instructions.

The gateway checks instruction/catalog revisions before dispatch. Adding, removing or modifying
SKILL.md or AGENTS.md invalidates affected receipts without a rebuild. Resource contents are read
fresh when requested. An expired or stale receipt must be replaced; active skills must then be
loaded again if still relevant. Content is not automatically repeated on every tool result.

The host must keep applicable guidance available across turns and context compaction, or request
it again. A server receipt is evidence of delivery, not evidence of the host's current context.

## Skills format and limits

Skills follow [Agent Skills](https://agentskills.io/specification): YAML frontmatter identifies a
skill, the Markdown body supplies instructions, and optional files carry supporting resources.
Disclosure follows [catalog, instructions, resources](https://agentskills.io/client-implementation/adding-skills-support).

```markdown
---
name: project-checks
description: Run and interpret this project's verification checks before integration.
---

Read references/checks.md when choosing the applicable verification commands.
Run those commands through the gateway's existing execution tools.
```

The catalog contains name, description, scope, revision hash and optional compatibility metadata.
It contains neither the full SKILL.md nor resource contents. Discovery reads bounded files on the
server to validate metadata and revisions; this does not inject their bodies into the model.
`skills.list` returns the catalog again when explicitly requested.

| Boundary                     | Limit                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| AGENTS.md                    | 32 KiB per file, strict UTF-8, whole-file delivery           |
| SKILL.md                     | 128 KiB; YAML frontmatter at most 8 KiB                      |
| Skill name                   | 1–64 lowercase letters/digits with single separating hyphens |
| Description / compatibility  | 1–1024 / at most 500 characters                              |
| Active skills                | 128 after deterministic overrides                            |
| Directory entries            | 512 per scanned skills directory                             |
| Instruction/catalog snapshot | 256 KiB                                                      |
| Text resource read           | 1 MiB per call, strict UTF-8                                 |
| Context receipts             | 1024 live receipts, four-hour TTL                            |

YAML duplicate keys, unsupported tags and aliases are rejected. Unknown optional metadata is
ignored; directory/name mismatches produce a diagnostic. A malformed individual skill is skipped
with a diagnostic. An unreadable/oversized AGENTS.md or unsafe/over-budget catalog fails bootstrap;
the gateway never silently truncates instructions. Context paths reject symlinks, junctions,
traversal and protected secret names. Resources must stay inside the activated skill directory.

Script execution and binary asset processing use existing authorized execution/media tools.
`skills.read` serves text; it does not execute a script, install a dependency or widen Paths.
For a global helper outside project Paths, an authorized interpreter may receive its absolute
gateway path while running in an authorized project cwd. This is subject to the existing command
and OS authority model, not a special skill permission.

## Recovery and integration

| Result                                             | Next action                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `context_required`                                 | Bootstrap and retry the rejected operation with the receipt                                  |
| `context_stale`                                    | Bootstrap again, reload relevant skills, then retry                                          |
| `instructions_unavailable` / `context_unavailable` | Inspect file permissions, format, size and configured root                                   |
| `skill_not_found`                                  | Check current catalog and diagnostics                                                        |
| `skill_not_activated`                              | Read SKILL.md before its resources                                                           |
| `context_capacity`                                 | Close unused current receipts; expired and policy-stale receipts are reclaimed automatically |

Preflight rejections return `operationExecuted: false`. This permits retrying that rejected
operation after recovery. Do not automatically retry an arbitrary command or provider failure:
the operation may already have run. See [coding-agent integration](CODING_AGENTS.md).
