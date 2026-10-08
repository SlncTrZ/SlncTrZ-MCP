# Agent Harness & Skills

Full connections receive guidance progressively; Gateway-only deliberately hides these tools.
Instructions are contextual guidance, never capability grants.

## 1. Harness Configuration

Default root: `<stateRoot>/harness/`; `SLNCTRZ_HARNESS_ROOT` selects an absolute custom root.
Fresh provisioning writes global AGENTS.md and seeds code-review/debug-and-test once.
Existing owner files are not overwritten and an initialized harness is not automatically
expanded by adding skills to the development repository.

With an authorized explicit projectRoot, discovery also reads its root AGENTS.md,
`.agents/skills/*/SKILL.md` and `skills/*/SKILL.md`. It does not scan arbitrary parent/home
directories or provide nested-directory instruction inheritance. Project skills override a
same-name global skill. See [Skills](../skills/README.md) for bundled versus repository skills.

| Bound                         | Limit                         |
| ----------------------------- | ----------------------------- |
| One AGENTS.md                 | 32 KiB                        |
| One SKILL.md                  | 256 KiB                       |
| One text resource             | 1 MiB                         |
| Active skill catalog          | 128 skills                    |
| Combined instructions/catalog | 256 KiB                       |
| Context receipts              | 1,024 active; four hours each |

## 2. Context Lifecycle

1. Call context.bootstrap, optionally with an authorized projectRoot.
2. Read sourced instructions, diagnostics, catalog and Product Agent Harness.
3. Pass contextToken as `slnctrzContext` on subsequent coding calls. MCP clients may instead
   use the advertised request-metadata key.
4. Activate a skill with skills.read(name); only then read its referenced text resources.
5. Close the receipt with context.close when finished.

Receipts bind principal, workspace, policy and discovered-content revisions. Expiry,
restart or changed policy/instructions requires bootstrap again. Rejected context guards
return `operationExecuted:false`; this is not a success event. Do not infer that an uncertain
non-context failure left a mutation unapplied.

## 3. Background Task Cancellation

Use task.cancel for the creator's Runner; cancellation requests termination through bounded
cleanup and grace periods. Wait/get confirms terminal state. It does not instantly guarantee
all remote side effects or independently spawned processes have disappeared. Coordination
tasks organize work and have their own ownership/state transitions.
