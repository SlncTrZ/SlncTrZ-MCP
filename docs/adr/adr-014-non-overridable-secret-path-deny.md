# ADR-014: Non-overridable secret-path denial in the kernel

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

A configured workspace root is an allow boundary, but it may still contain credentials,
environment files, private keys, or repository internals. Treating the workspace root as
sufficient authorization would allow a broad root to override the security invariant that
secret deny rules take precedence over allow rules.

Filesystem tools also need one consistent boundary mechanism. Reimplementing deny logic
inside each tool would create policy drift and different bypass behavior.

## Decision

The trusted kernel owns a shared filesystem boundary that runs before tool-specific I/O.

- Absolute paths, NUL bytes, lexical traversal, and canonical escape are rejected.
- The configured root and the requested/canonical relative path are checked.
- Protected directory and filename rules are intrinsic hard denies.
- Workspace configuration cannot remove or weaken intrinsic denies.
- Future administrator deny rules are additive.
- Tools return stable, non-sensitive error codes and messages.
- Changes to the intrinsic deny set require security review and an ADR update.

The initial protected set covers common credential directories, repository internals,
environment files, package-manager credential files, network credential files, and
default private-key filenames.

## Consequences

- **Positive:** A broad workspace root cannot expose common credential material.
- **Positive:** Read, search, write, and edit share identical path semantics.
- **Positive:** Policy review has one kernel enforcement point.
- **Negative:** A legitimate workspace file with a protected name is inaccessible.
- **Negative:** Name-based denial is defense-in-depth, not secret classification; explicit
  workspace and capability policy remains mandatory.
- **Neutral:** Additional secret stores require additive rules or a provider-specific deny
  root without changing the model-facing tool contract.
