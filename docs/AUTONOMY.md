# Choosing an Autonomy Level

SlncTrZ-MCP is designed to be useful for real work. Its autonomy setting tells the owner how directly the model may use the authority of the operating-system account running the gateway.

## Restricted

Choose **Restricted** when you want to explicitly curate the model-facing capability surface.

- Core file tools normally operate inside configured **Paths**.
- `core.exec` starts executables authorized by **Commands** (`command.json`).
- `task.start` uses that same command/Path authority when launching an asynchronous Runner task.
- Execution cwd is constrained to configured Paths.
- Secret-path and canonical-containment checks remain active for core file tools.

Restricted is a policy boundary, **not a complete OS sandbox**. If you authorize a powerful shell or interpreter such as PowerShell, `cmd`, Bash, Python or Node, that program can itself use whatever filesystem/process rights the gateway OS account has. Only authorize tools you are comfortable giving to the model.

Recommended for:

- shared or work-managed computers;
- cautious first-time setup;
- environments where the owner wants explicit command/path curation.

## Autonomous

Choose **Autonomous** when you want SlncTrZ to behave as a capable autonomous development/automation system.

- Core file tools may use any path the gateway OS user can access.
- `core.exec` may resolve/run executables available to that user without requiring a command-catalog entry.
- `task.start` follows the same autonomous OS-user execution authority; it does not elevate beyond it.
- Working directories may be outside configured Paths.
- Per-operation approval is not part of the autonomy model.
- Technical guards such as input validation, atomic writes, timeouts, output caps, cancellation and audit remain active.

The authority rule is intentionally simple:

```text
model authority ≈ gateway process authority ≈ OS user authority
```

SlncTrZ does **not** silently elevate. On Windows, an unelevated gateway remains unelevated even if the account belongs to Administrators; UAC still protects operations that require elevation. If the owner deliberately starts the gateway elevated, the model receives that elevated process authority.

Recommended for:

- personal development machines;
- trusted automation hosts;
- users who prefer capability and low friction over workspace-by-workspace permission prompts.

## Practical setup guidance

| Machine / use case                                          | Recommended level                                    |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| Personal coding machine, owner wants broad autonomy         | **Autonomous**                                       |
| Shared workstation or machine with sensitive unrelated data | **Restricted**                                       |
| New user evaluating SlncTrZ                                 | **Restricted**, then switch to Autonomous if desired |
| Dedicated automation box under a dedicated OS account       | **Autonomous** is usually appropriate                |

The most important boundary is the **OS account running SlncTrZ**. A dedicated user account is the cleanest way to give the model broad autonomy without granting access to another user's private data.

Logical coordination tools (`task.create/list/get/claim/release/complete/fail/cancel`) do not widen either autonomy mode. Their instructions/results are workspace context only, not capability grants. Task Runtime state is in-memory and is cleared by a gateway restart.

## What SlncTrZ promises

SlncTrZ aims for transparent authority, not pretend safety:

- the owner chooses the autonomy level;
- the active level should be visible in `/owner`;
- the gateway does not secretly widen OS privileges;
- audit remains available even when approvals are not required;
- models are expected to use the granted authority purposefully, while the owner remains responsible for choosing the machine/account boundary.
