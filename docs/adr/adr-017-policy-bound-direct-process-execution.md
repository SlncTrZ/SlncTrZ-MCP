# ADR-017: Policy-bound direct process execution

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

`core.exec` runs an external process, so a mistake is arbitrary code execution rather
than wrong bytes in one file. The THREAT_MODEL §6 Execution gate was ungated. Phase 3.1
closes it with a deliberately narrow, POSIX-only, fixed-command surface: the caller
selects a pre-authorized definition by `commandId` and never supplies a binary, a shell
string, argv, cwd, or stdin.

## Decision

- Commands are operator-authored definitions selected by `commandId`; the caller never
  supplies a binary path, a shell string, or free-form argv.
- Direct `spawn` with `shell: false`; shell execution is never available at any layer.
- `execRoot` is a third policy root that must not overlap `writeRoot` in either
  direction, validated at snapshot construction with real containment and failing
  closed at startup.
- Phase 3.1 accepts fixed commands only: `allowExtraArgs: false`, `allowStdin: false`,
  `cwdMode: "fixed"`. Caller args/cwd/stdin are rejected at the MCP boundary.
- Phase 3.1 is POSIX-only. On Windows `core.exec` is absent and direct kernel
  invocation returns `unsupported_platform` before registry lookup or spawn; no Windows
  process-tree termination fallback is added. A later Windows slice requires a separate
  administrator-reviewed Job Object/native-helper ADR.
- Extra-argument policy, relative-cwd, and stdin are deferred to a future versioned
  typed argument-policy ADR; they are not Phase 3.1 work.
- Child environment is a fixed minimal allowlist (`PATH` from `SLNCTRZ_EXEC_PATH`,
  empty if unset, plus validated `fixedEnv`); `process.env` is never inherited, and
  loader/runtime-injection keys (`LD_PRELOAD`, `NODE_OPTIONS`, ...) are rejected.
- Outcomes are results, not kernel errors: a non-zero exit code, timeout, and
  cancellation resolve as an `ExecResult`; only launch-prevention failures throw
  `ExecError`. `ExecErrorCode` has no `timeout` or `cancelled` entry.
- A single-settle state machine (`exit | timeout | abort | spawn_error`) resolves each
  spawn exactly once, cleaning up all timers/listeners/streams.
- Timeout and cancellation terminate the full process group on POSIX (`detached`
  process group, then `SIGKILL` after a bounded grace period).
- Output is bounded and deterministically truncated with per-stream flags; UTF-8
  output decoding uses deterministic replacement.
- Network denial is enforced by allowlist minimalism in Phase 3, not by a sandboxed
  guarantee; this is stated plainly.
- `commandId` is added to `ToolAuditEvent` as an optional field — knowing which
  registered command ran is essential for operational review of an execute-class tool,
  and it is neither filesystem content nor a secret. No `args`, `stdin`, `stdout`,
  `stderr`, `cwd`, or environment value is ever audited.
- No new dependency.

## Consequences

- **Positive:** A caller cannot influence the binary, any flag, or any free-form
  argument; the only caller influence is a bounded, fixed definition.
- **Positive:** A vulnerable or malicious command cannot be introduced by a model or a
  workspace file, only by an explicit operator registry entry.
- **Positive:** `execRoot` cannot overlap `writeRoot`, so a writable directory cannot
  also be trusted to hold executables.
- **Negative:** Phase 3.1 only runs fixed-argv idempotent commands; general positional
  argument and stdin workflows are deferred.
- **Negative:** No enforced network sandbox; an operator must not add network-reaching
  binaries to the registry.
- **Risk and mitigation:** Process-tree termination is platform-divergent; Phase 3.1
  limits that risk by being POSIX-only and explicitly deferring Windows.

## Alternatives considered

Caller-supplied argv with a pattern check was rejected because a generic regex is not
a semantic argument policy and a safe value for one binary can be privileged syntax for
another. Adding `execa`/`tree-kill`/a shell-quoting library was rejected. Claiming
network or Windows process-tree guarantees without implementation was rejected by the
"evidence before claims" rule.

## Verification

`npm run check` must pass kernel, policy, audit, and authenticated MCP tests on Node 22
and Node 24 on Linux (the exec spawn behavior), plus a separate Windows check that
`core.exec` is fail-closed. Coverage includes fixed execution, no-caller-args,
non-zero exit, environment allowlist (no gateway leak), bounded/truncated output,
timeout and abort process-tree kill, binary revalidation, non-overlap, and secret-free
audit.

> This closes the THREAT_MODEL §6 Execution gate on POSIX for Phase 3.1. Windows is
> explicitly deferred and not claimed covered.
