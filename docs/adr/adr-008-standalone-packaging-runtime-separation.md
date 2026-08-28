# ADR-008: Standalone packaging is separated from runtime architecture

> Status: Accepted
> Date: 2026-08-28
> Owners: SlncTrZ

## Context

PLAN Phase 8 requires a non-developer distribution that does not depend on a system-wide
Node.js installation, npm, Git, or a repository checkout. Packaging must not introduce
standalone-only authorization or business-logic branches into the trusted gateway runtime.
Node SEA remains version-sensitive: Node 22/24 executes injected code through the CommonJS
embedder path, while the repository runtime is authored as ESM.

Updates also cross a supply-chain trust boundary. A downloaded archive or successful build
is not sufficient evidence that an artifact is authentic, complete, executable, or safe to
activate.

## Decision

- Developer mode continues to run the emitted ESM application from a repository checkout.
- Standalone mode bundles the same application entry into one CommonJS file, creates a Node
  SEA preparation blob, and injects it into the exact Node binary that created the blob.
- The application bootstrap is an explicit async function with no import-time startup side
  effect. The CLI dispatches help, version, install, and rollback before normal bootstrap.
- Updates are explicit operator actions. There is no background auto-update.
- Release manifests use a strict schema, HTTPS URLs without userinfo, exact target identity,
  declared byte length, and lowercase SHA-256.
- Artifacts are streamed into a same-filesystem staging directory and verified before a
  version directory is activated.
- Activation is a same-filesystem atomic current.json replacement. Resolution validates
  activation metadata and does not rely on symlinks.
- Existing versions are immutable: same-version/same-artifact installation is idempotent,
  while artifact substitution fails closed.
- Release publication remains outside CI. CI may build, upload, re-download, checksum, and
  smoke-test artifacts, but it does not create a GitHub Release.
- Per-target signing/notarization and clean-machine runtime evidence are release gates, not
  properties inferred from source code.

## Consequences

- **Positive:** Packaging can evolve without changing the policy, OAuth, MCP, or tool
  authorization boundaries.
- **Positive:** Interrupted or tampered upgrades retain the previously active version.
- **Positive:** Linux x64 produces a self-contained executable whose CLI and deny-all
  gateway bootstrap can be smoke-tested without a system Node.js runtime.
- **Negative / costs:** SEA artifacts include the Node runtime and are large.
- **Negative / costs:** Each OS/architecture target needs a native build runner and separate
  signing/runtime evidence.
- **Risks and mitigations:** SHA-256 does not replace publisher authenticity. HTTPS, release
  access control, checksums, platform signing, and an approval-gated publication process
  remain cumulative controls.

## Alternatives considered

- **Ship npm-only:** rejected because it requires a developer runtime.
- **Archive dist with portable Node:** retained as a possible fallback, but it does not
  provide the single-file prototype requested by Phase 8.
- **Bundle injected ESM on Node 24:** rejected by measured runtime behavior; the Node 24 SEA
  embedder executed it as CommonJS.
- **Symlink-only activation:** rejected because Windows portability and metadata validation
  would depend on filesystem-specific link behavior.
- **Automatic release publication:** rejected until target, checksum, signing, and
  verification records are complete.

## Verification

- Standalone manifest, fetch, installer, CLI, upgrade, rollback, corruption, and idempotence
  tests pass.
- A Node 24 Linux x64 SEA artifact builds from the exact matching Node binary.
- The binary prints SlncTrZ-MCP help/version in a clean Debian container without Node/npm.
- The binary reaches both gateway listeners under a generated in-memory verifier and
  deny-all configuration.
- npm run check passes with 326 tests passed / 1 skipped and npm run build passes on
  Node 22 and 24.
- Windows and macOS standalone support require native CI, signing/notarization, and
  clean-machine evidence before being marked verified.
