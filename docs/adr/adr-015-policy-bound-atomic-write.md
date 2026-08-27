# ADR-015: Policy-bound atomic filesystem writes

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Phase 3 introduces the first mutating kernel capability. OAuth authentication alone does
not authorize a path or a mutation, and a general filesystem root would blur the boundary
between inspection and modification. Existing-file replacement also needs protection
against stale model context and partial writes.

## Decision

The application creates one immutable, versioned kernel policy snapshot at startup.
Each MCP exchange binds the authenticated client identity and scopes to that snapshot
before registering filesystem tools.

- Read and write roots are separate configuration values.
- `core.write` is absent unless an explicit write root is configured.
- Missing identity, scope, capability, or root fails closed.
- Writes default to dry-run.
- Creating a file uses a same-directory temporary file and no-overwrite publication.
- Replacing a file requires the caller's expected SHA-256 of the current content.
- In-process mutations to the same canonical target are serialized.
- Replacement revalidates the hash immediately before atomic rename and preserves mode.
- The shared canonical boundary and intrinsic secret-path denial apply before mutation.
- Every write attempt emits a structured audit event with client, workspace, capability,
  policy version, decision, result, and duration, but never path or content.

Policy reload, multi-workspace selection, approval hooks, and writable/executable
composition validation remain Phase 4 work. Until execution exists, write authorization
does not imply executable trust.

## Consequences

- **Positive:** Read access never silently becomes write access.
- **Positive:** Stale callers cannot overwrite an existing file without detection.
- **Positive:** Interrupted writes do not expose partially written target content.
- **Positive:** Mutations are attributable without placing file data in logs.
- **Negative:** Existing-file updates require a preview/read step to obtain the current hash.
- **Negative:** Startup configuration is static until atomic policy reload is implemented.
- **Risk and mitigation:** Portable filesystem APIs cannot eliminate every path race on all
  platforms; canonical revalidation, exclusive temporary creation, hash recheck,
  no-overwrite publication, cleanup tests, and fail-closed errors reduce the residual risk.

## Alternatives considered

A single read/write root was rejected because it grants mutation too broadly. Direct
truncate-and-write was rejected because crashes can corrupt targets. Blind atomic rename
was rejected because it still permits lost updates. Logging paths was rejected because
audit attribution does not require exposing workspace data.

## Verification

`npm run check` must pass policy, boundary, write, audit, configuration, and authenticated
MCP integration tests. The tests cover dry-run, atomic create/replace, stale hashes,
permissions, traversal, protected paths, symlinks, size limits, cancellation, cleanup,
tool visibility, and secret-free audit output.
