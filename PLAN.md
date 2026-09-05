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

The owner manages only:

```text
Autonomy
Paths
Commands
MCP Servers
```

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
3. core.ping reports shared Paths and supported capabilities
4. tools/list contains ping/read/search/write/edit/exec plus the enabled `task.*` Runner/Coordinator surface
5. core.write without dryRun applies
6. core.edit without dryRun applies
7. dryRun:true previews write/edit
8. core.exec without dryRun runs an allowed command; dryRun:true previews
9. Add Path through Owner Console
10. new Path is immediately readable/writable without manual reload
11. Add an MCP provider
12. provider tools appear immediately without workspace grant/reload
13. disable provider → tools disappear
14. enable provider → tools return
15. Task Runner start/get/wait/cancel preserves process lifetime across later requests and reuses core.exec authority
16. Task Coordinator multi-client claim has exactly one winner and claimant/creator mutation rules hold
17. restart gateway
18. Paths, Commands and MCP providers persist; in-memory Task Runtime state resets as documented
19. no owner.* MCP tools
20. canonical Product Agent Harness is present while project AGENTS/instruction files remain contextual and non-authoritative
21. no bind/profile/proposal ceremony
```

Windows acceptance includes native `core.exec`, PATHEXT `.cmd/.bat` execution, process-tree termination, restricted command-catalog behavior, autonomous execution outside configured Paths, managed-task cancellation, and public Git Bash User Install lifecycle acceptance.

## Engineering rule

Do not add new authorization layers beyond the demonstrated product concepts: Autonomy, Paths, Commands and MCP Servers.

Autonomy guidance is part of the product contract:

- **Restricted** is for users who want explicit Paths/Commands setup. It is not advertised as an OS sandbox when shells/interpreters are authorized.
- **Autonomous** is for users who want the model to operate with the gateway process user's real filesystem/process authority without per-operation approval.
- SlncTrZ does not silently elevate; OS/UAC/user-token boundaries remain authoritative.

Security complexity belongs behind those surfaces: OAuth, path containment where applicable, secret handling, command selection, credential isolation, atomic generation activation, bounded execution and metadata-only audit.
