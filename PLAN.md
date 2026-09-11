# SlncTrZ-MCP Product Plan

## Product contract

SlncTrZ-MCP is intentionally small:

```text
Connect
→ Choose autonomy level
→ Paths work immediately
→ Add Path/Command/MCP when needed
→ Done
```

The owner-facing **authority controls** remain deliberately small:

```text
Autonomy
Paths
Commands
MCP Servers
```

Editable global `AGENTS.md` and Agent Skills are coding guidance, not additional authority controls.

## Completed simplification

- Authenticated requests resolve directly to one active product snapshot.
- Product policy schema v2 keeps one simple autonomy switch plus `paths[]`: `authorityMode = restricted | autonomous`.
- Legacy workspace/profile/binding state is parse-only migration input.
- Fresh managed state creates shared Paths immediately.
- `core.read/search/write/edit` derive from Paths.
- `core.exec` is native on Windows and POSIX. Restricted mode derives it from Paths + `command.json`; autonomous mode derives it from OS-user authority.
- Write/Edit/Exec apply by default; preview is explicit `dryRun:true`.
- Proposal/approval state machine removed from normal owner mutations.
- Model-facing Owner Admin tools removed.
- Legacy workspace-managed harness/instruction-context authority removed; the canonical Product Agent Harness from root `AGENTS.md` is delivered as product working guidance and remains non-authoritative.
- Legacy fixed exec registry removed.
- MCP workspace/profile/tool-subset grants removed; enabled provider = exposed provider.
- Owner Console remains small: Autonomy / Paths / Commands / MCP Servers with typed intents.

## Current release acceptance

Source quality on Linux Node 22 and Node 24 must pass:

```text
npm ci
npm run check
npm run docs:check
npm run build
```

The Linux x64 standalone release must then pass version/build/hash identity, public GitHub release-asset redirect download, and clean User Install acceptance before promotion from prerelease candidate.

Named client support still requires real-client acceptance on the **published installed artifact**, not only a development checkout:

```text
1. start from clean managed state
2. connect/authenticate Claude or ChatGPT
3. core.ping reports shared Paths, supported capabilities and harness orientation
4. tools/list contains context.bootstrap/context.close/skills.list/skills.read plus authorized core/media/task/provider tools
5. context.bootstrap works global-only when no project AGENTS.md exists
6. optional projectRoot adds project instructions/skills without widening filesystem authority
7. absent, foreign or stale receipts reject ordinary work before effects; recovery executes the requested operation once
8. core.write without dryRun applies
9. core.edit without dryRun applies
10. dryRun:true previews write/edit
11. core.exec without dryRun runs an allowed command; dryRun:true previews
12. Add Path through Owner Console
13. new Path is immediately readable/writable without manual reload
14. Add an MCP provider
15. provider tools appear immediately without workspace grant/reload
16. disable provider → tools disappear
17. enable provider → tools return
18. Task Runner start/get/wait/cancel preserves process lifetime across later requests and reuses core.exec authority
19. Task Coordinator multi-client claim has exactly one winner and claimant/creator mutation rules hold
20. restart gateway
21. Paths, Commands and MCP providers persist; in-memory Context/Task Runtime receipts/state reset as documented
22. no owner.* MCP tools
23. canonical Product Agent Harness is present while global/project AGENTS and skills remain contextual and non-authoritative
24. no bind/profile/proposal ceremony
```

Windows acceptance includes native `core.exec`, PATHEXT `.cmd/.bat` execution, process-tree termination, restricted command-catalog behavior, autonomous execution outside configured Paths, managed-task cancellation, and public Git Bash User Install lifecycle acceptance.

## Engineering rule

Do not add new authorization layers beyond the demonstrated product concepts: Autonomy, Paths, Commands and MCP Servers.

Autonomy guidance is part of the product contract:

- **Restricted** is for users who want explicit Paths/Commands setup. It is not advertised as an OS sandbox when shells/interpreters are authorized.
- **Autonomous** is for users who want the model to operate with the gateway process user's real filesystem/process authority without per-operation approval.
- SlncTrZ does not silently elevate; OS/UAC/user-token boundaries remain authoritative.

Security complexity belongs behind those surfaces: OAuth, path containment where applicable, secret handling, command selection, credential isolation, atomic generation activation, bounded execution and metadata-only audit.

## v0.3.1 product visibility and usage telemetry

v0.3.1 turns two dogfood findings into product work:

1. raise bounded `SKILL.md` support to 256 KiB so substantial Agent Skills can remain first-class without weakening progressive disclosure;
2. add passive `/usage` observability so owners can see gateway traffic, per-tool context, progressive-disclosure savings, and estimated cost avoided without storing conversation/tool payloads.

The release also changes the public documentation posture. README and operator docs are written for people evaluating/running the product, in the maintainer voice, with candid adoption status and without claiming independent security validation that does not exist. Model-specific operating guidance remains in `docs/MODEL_GUIDE.md`.

Release contract: telemetry is metadata-only, bounded, owner-readable, separate from audit, and fail-open. See ADR-028 and the v0.3.1 release-acceptance section.

## v0.3.0 coding harness

Owner-approved scope: automatic global AGENTS.md, optional project context, mandatory bootstrap
receipts, progressive Agent Skills, preserved installation state, client-neutral MCP integration.
`context.bootstrap`, `context.close`, `skills.list` and `skills.read` provide the new protocol surface.
Existing execution, tasks, images and provider lifecycle remain the capability layer. No general
extension SDK or external-agent loop is introduced. Acceptance is tracked in RELEASE_ACCEPTANCE
and the v0.3.0 runtime QA report; source completion does not itself mean a published release.
