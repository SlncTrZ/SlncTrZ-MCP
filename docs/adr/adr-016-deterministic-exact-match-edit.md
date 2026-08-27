# ADR-016: Deterministic exact-match filesystem edits

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Phase 3 completes the mutating file kernel with `core.edit`. Editing is more hazardous
than writing a whole file because a fuzzy or line-oriented patch can silently change the
wrong bytes. A model-driven client may present out-of-date content, duplicate matches, or
operations that overlap, and each outcome must be deterministic and fail closed. The
capability must also preserve the bounded, attributed, and secret-free guarantees already
established for `core.write` (ADR-015).

## Decision

`core.edit` exposes exact-match replacements only. Each call targets one existing file,
one required base SHA-256, and one or more caller-supplied `oldText`/`newText` pairs. All
operations resolve against one immutable snapshot of the original content.

- Exact-match replacement is the only Phase 3 mode; fuzzy, regex, unified-patch, and
  line-number patching are not implemented.
- A missing match fails with `match_not_found`; more than one occurrence fails with
  `ambiguous_match`; intersecting spans fail with `overlapping_edits`.
- The base SHA-256 is required for both dry-run and execution and is rejected if stale.
- Dry-run is the default; mutation happens only when `dryRun` is exactly `false`.
- Diff output uses the `exact-replacements-v1` format, is byte-bounded, contains only
  caller-supplied `oldText`/`newText`, and reports truncation without splitting a hunk.
- Untouched bytes, line endings, and UTF-8 encoding are preserved.
- Atomic commit is delegated to the ADR-015 writer; no new dependency is introduced.
- Editing never creates a file; a target that disappears returns `conflict`.
- `core.edit` is authorized only through an explicit write root.

## Consequences

- **Positive:** Ambiguous or stale model context fails loudly rather than editing the
  wrong bytes.
- **Positive:** Operation order cannot change the result or content hash.
- **Positive:** Audit attribution carries client, workspace, and policy without path,
  content, or diff.
- **Positive:** No new dependency and no reimplementation of the shared boundary, atomic
  writer, or target serialization.
- **Negative:** Multi-hunk and complex edits must be composed from several calls.
- **Risk and mitigation:** Exact matching rejects legitimate repeated substrings; callers
  must supply enough surrounding context to disambiguate.

## Alternatives considered

Fuzzy matching and line-number patching were rejected because they can silently apply a
patch to the wrong location. Unified-diff input and regex replacement were rejected to
keep the Phase 3 surface minimal and deterministic. Reimplementing atomic replace in the
edit module was rejected because ADR-015 already owns that guarantee.

## Verification

`npm run check` must pass kernel, policy, audit, and authenticated MCP integration tests.
The coverage includes dry-run and execution, exact and ambiguous matches, overlap
rejection, stale hashes, limits, cancellation, traversal, protected paths, symlinks, and
secret-free audit output.

> Future structured-patch modes require a versioned contract and must not silently change
> the current `exact-replacements-v1` semantics.
