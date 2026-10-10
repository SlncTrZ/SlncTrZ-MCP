# Threat Model

Current gateway boundaries and release-trust assumptions.

## 1. Security Model

Restricted mode enforces file Paths/protected-name checks and executable catalogs.
Autonomous mode uses the gateway OS account. Neither mode provides an OS sandbox:
a permitted shell/interpreter can exercise that account's permissions. The gateway does
not silently elevate UAC/sudo authority. Keep high-privilege accounts out of ordinary deployment.

## 2. Threats & Mitigations

### Filesystem & Secrets

Restricted file tools reject protected names, traversal and unsafe links; atomic writes
reduce partial-update corruption. Autonomous file tools use OS-account authority instead.
These rules do not prevent an authorized shell or independent provider from reaching secrets.
Instruction text, skills and recalled provider content must not grant new capabilities.

### Command Execution

Commands are directly spawned with bounded timeout/output. A catalog allowlist authorizes
executables; it cannot make arbitrary script arguments safe. Remote/provider actions have
their own authority, lifecycle and recovery requirements.

### Managed task requirements

Task-state exhaustion is bounded by concurrency, queue, timeout and output limits.
Runner records are creator-private; Coordinator records are workspace-visible and claims
have exactly one owner. Task text and context receipts cannot widen authority.
State is in-memory; a host crash is not durable task recovery.

### Downstream Providers & Secrets

STDIO subprocesses are supervised; remote HTTP providers are independent services.
Ambiguous failures and cancellations are not replayed. At most one automatic replay is
allowed after explicit pre-dispatch session rejection proves no execution; recovery keeps
the original deadline and a rolling incident budget. In the v0.4.5 source contract, request
cancellation does not create/overwrite provider recovery incidents or restart healthy providers.
Cancellation is not proof that remote side effects were undone.
Credential rotation rollback attempts to restore the active configuration; an external outage
or failed rollback still needs diagnosis and does not have a zero-downtime guarantee.

### Supply Chain & Releases

Ed25519 publisher signature verification authenticates exact canonical manifest bytes;
the manifest's SHA-256/size binds the SEA bytes. This is not direct SEA or Windows Authenticode
signing. Fresh bootstrap additionally depends on trusted acquisition of the installer/binary.

Release signing-key misuse is constrained by the protected release-signing Environment,
tag-only workflow and main-history checks. External reviewer/self-review/tag restrictions
and absence of duplicate secrets require independent evidence; workflow YAML alone proves
none of that custody configuration. Disposable local/CI keys certify neither publisher trust
nor public release readiness.

### Telemetry & Ledger

Usage retains numeric gateway-boundary estimates, not prompt bodies, paths, tool arguments
or outputs. Audit has a different bounded event schema. The unwired lifecycle ledger sanitizes
known sensitive keys and bearer-style strings; this is not a guarantee for arbitrary secret
text under an innocuous field. Callers must keep credentials out of operation detail.

Optional Prediction Seam is owner-controlled and default-off. It invokes the configured
CyberBrain backend with gateway transport metadata, not a new client grant, and never copies
tool arguments/provider output. It records before outcome and excludes CyberBrain/read-only
calls. Its one-second learning deadlines can leave missing/unresolved records; shared provider
credentials may collapse attribution into one backend identity. The v0.4.5 cancellation fix
prevents those learning deadlines from triggering shared-provider recovery. Keep the seam
disabled on v0.4.4 to avoid that known defect.

See [Security](../SECURITY.md) and [Release](../RELEASE.md).
