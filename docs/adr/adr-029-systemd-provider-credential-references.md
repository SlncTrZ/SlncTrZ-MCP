# ADR-029: Systemd provider credential references

Status: Proposed
Date: 2026-10-09

## Context

A Linux provider may receive its bearer credential through systemd's runtime credential
directory, backed by an encrypted source. The existing gateway store only accepts raw
bearer/header/environment values, forcing a second persistent copy or leaving the
provider unavailable when it is configured with a descriptor.

## Decision

Extend only the owner-managed MCP credential store with the strict `systemd-bearer`
descriptor: service unit and credential name. The ordinary `credentialRefs` contract
and internal `ProviderCredential` bearer shape remain unchanged.

- Persist the descriptor, not the runtime credential value.
- Resolve beneath `/run/credentials` with the gateway OS identity; do not elevate it.
- Require Linux, valid path components, a non-symlink unit directory and non-symlink
  private regular file. Open nonblocking to reject FIFOs before they can hang resolution.
- Accept an owner-private file or a root/root file with a read-only ACL mask; retain
  OS permission/ACL enforcement. Bound reads to 16 KiB and redact failures to stable errors.
- Resolve afresh on each call; metadata listing does not resolve secrets.
- Reject resolution on unsupported platforms. Existing bearer/header/env refs keep their behavior.

## Consequences

Provider discovery and runtime startup can reuse systemd credentials without storing
their plaintext values in gateway JSON. Rotation is visible at the next resolution,
not automatically in an already-open transport session. Missing credentials leave the
affected provider unavailable while unrelated providers can still start.

The Owner Console token form is unchanged; descriptors are provisioned by the owner.
The existing service identity must have OS-granted read access. The filesystem checks
do not sandbox commands/providers or grant access to another service's credentials.

## Verification and rollback

Exercise private files, descriptor-only persistence, rotation, missing files, traversal,
symlinks, directories/FIFOs, size/content bounds and unsupported-platform rejection.
Run Windows and Linux gates. Root-owned ACL behavior also requires deployment-specific
OS permission checks; non-root unit fixtures do not prove every ACL configuration.

Rollback to a binary without descriptor support makes such providers unavailable.
Remove/change the owner descriptor before rollback; never copy the decrypted value
into public source or logs as a workaround. Keep published v0.4.2 artifacts unchanged.
