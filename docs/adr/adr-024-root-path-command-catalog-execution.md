# ADR-024 — Shared Paths + Command Catalog Execution

## Status

Partially superseded by the current cross-platform Autonomy contract.

> Current-contract note (2026-09-04): Restricted mode still uses shared Paths + `command.json`, but `core.exec` is native on Windows and POSIX. Autonomous mode deliberately bypasses the Restricted command catalog/Path containment and instead uses the runtime OS user's executable/cwd authority. The bounded spawn/audit/process-cleanup rules remain active in both modes.

## Historical Decision

`command.json` is the sole normal execution authority. `core.exec` is available only when:

```text
supported POSIX host
∩ cwd inside configured Paths
∩ command + leading args match command.json
```

Executables may live outside configured Paths. Paths constrain where the process may run; the command catalog constrains what may run.

Processes are spawned directly with `shell:false`, bounded time/output and metadata-only audit records.

`core.exec` executes by default. Pass `dryRun:true` only when preview is explicitly desired; omitted or `dryRun:false` applies the command.

There is no second fixed-command registry and no separate execution root in the active product model.

## Consequences

- normal development tools such as Git, Node.js, npm and Python can be authorized without placing binaries inside project directories;
- one shared Paths list controls filesystem and cwd containment;
- command authority remains globally reviewable in one small file;
- Historical statement: Windows omitted `core.exec` at the time of this ADR. This is superseded; current Windows runtime supports native `core.exec` under the same Restricted/Autonomous authority model.
