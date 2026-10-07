---
name: invariant-check
description: Verify concrete functional invariants across state transitions, destructive operations, compatibility boundaries, and authority-sensitive flows, and report only reproducible contract violations.
---

# Invariant Check

Use this skill when correctness depends on conditions that must remain true across an operation, retry, restart, migration, rollback, or destructive action.

An invariant is a concrete product contract that must hold at a defined boundary. Do not invent invariants from generic best practices.

## Workflow

1. **Name the invariant and its source**
   - Derive it from supported behavior, tests, public contracts, state-machine semantics, or explicit user requirements.
   - Record where the contract comes from before judging implementation.

2. **Locate enforcement points**
   - Identify every mutation or transition that can establish, preserve, or violate the invariant.
   - Include retry/replay, rollback, restart recovery, migration, and destructive paths when they are reachable.

3. **Construct a concrete negative case**
   - Use a supported input/state/path that can actually reach the enforcement point.
   - Prefer a focused test or bounded reproduction over theoretical reasoning.

4. **Check before and after state**
   - Verify what state exists before the operation, what mutation occurred, and what remains after success or failure.
   - For destructive operations, prove preservation or deletion behavior explicitly.
   - For compatibility boundaries, verify both the new path and previously supported path when backward compatibility is part of the contract.

5. **Classify the result**
   - **PASS:** invariant holds for the exercised path.
   - **FAIL:** a concrete reproduction causes crash, deadlock/hang, data loss, corruption, inoperable feature, or functional contract violation.
   - **UNVERIFIED:** required platform, state, credential, client, or runtime evidence is unavailable.

## Common Invariants

Use only when applicable to the actual product contract:

- A non-purge uninstall preserves state/configuration.
- A committed mutation is durable and a failed mutation does not leave partially activated state.
- Retrying an idempotent request does not duplicate durable side effects.
- A supported legacy client/flag/schema remains usable during a compatibility window.
- An Owner-granted capability remains usable unless another explicit product rule limits it.
- Migration and rollback preserve data according to the documented compatibility contract.

## Reporting Standard

For every failure, provide: invariant, triggering condition, exact enforcement gap, resulting functional failure, and reproduction evidence.

Do not report a defect merely because a design could be hardened further, permissions could be narrower, secrets could be handled differently, or additional timeouts/retries could be added. Keep optional hardening separate and only mention it when the user asks for it.

Invariant checking is normally read/test-oriented; it does not authorize implementation, commit, migration, restart, or deployment unless separately requested.
