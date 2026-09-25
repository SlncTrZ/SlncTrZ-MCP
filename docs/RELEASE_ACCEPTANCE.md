# Release Acceptance Evidence

This document defines the evidence format for a SlncTrZ-MCP public release. It is not a claim that every item below has already passed.

## Release-signing custody gate

Before any production signing key is installed or any signed candidate is approved, verify the external GitHub configuration as a release gate:

- the `release-signing` Environment exists **before** the workflow run; do not rely on implicit environment creation;
- deployment branches/tags use **Selected branches and tags** with a Tag rule matching `v*` and no branch rule for signing;
- at least one required reviewer is configured;
- **Prevent self-review** is enabled;
- administrator bypass of protection rules is disabled;
- `SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64` exists only as an Environment secret for `release-signing`; no same-name repository/organization secret remains;
- `SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64` contains the matching public DER/SPKI key;
- the `aggregate-release` workflow job has a tag-only condition, references `release-signing`, and verifies the tag commit is on `origin/main` history before the signer runs;
- a non-tag manual `workflow_dispatch` skips aggregate/sign/publish and cannot obtain the production private key.

Record:

```text
release-signing environment pre-created: PASS/FAIL
selected tag rule v*: PASS/FAIL
required reviewer: PASS/FAIL
prevent self-review: PASS/FAIL
admin bypass disabled: PASS/FAIL
private key environment-only: PASS/FAIL
public/private key match: PASS/FAIL
non-tag dispatch cannot sign: PASS/FAIL
tag commit on main history: PASS/FAIL
```

Environment protection is repository configuration, not something source tests can self-certify. A workflow that merely names `release-signing` is insufficient evidence.

## Automated Linux x64 candidate evidence

Produced by `.github/workflows/standalone.yml`:

- Node 22/24 quality gate;
- public docs contract;
- production dependency audit;
- Linux x64 SEA build;
- binary help/version/build-info;
- checksum + manifest projection;
- Ed25519 `manifest.json.sig` created only after the protected release-signing gate;
- version/tag/build identity gate plus tag-on-main-history check;
- prerelease candidate publication;
- exact public GitHub release-asset redirect path;
- clean User Install in isolated HOME;
- status/doctor;
- default uninstall preserving state/config;
- promotion only after clean User Install pass.

Record:

```text
tag:
commit:
package version:
binary version:
binary build commit:
linux-x64 sha256:
manifest:
manifest.json.sig verification: PASS/FAIL
release-signing environment approval/run:
workflow run:
clean User Install: PASS/FAIL
promotion: PASS/FAIL
```

## Automated Windows x64 candidate evidence

Produced by `.github/workflows/standalone.yml` on `windows-latest`:

- native Node 24 source gate;
- native `win32-x64` SEA build;
- Windows binary help/version/build-info;
- checksum + manifest projection;
- release identity gate;
- exact public GitHub release bootstrap through Git Bash;
- native Windows User Install without Node/npm runtime dependency;
- running health + authenticated status;
- `status --json`;
- `doctor --json` with no FAIL;
- default uninstall preserving state/config.

Record:

```text
tag:
commit:
package version:
windows binary version:
windows build commit:
win32-x64 sha256:
manifest:
workflow run:
Git Bash clean User Install: PASS/FAIL
running health/status/doctor: PASS/FAIL
default uninstall preservation: PASS/FAIL
manifest publisher signature: PASS/FAIL
Authenticode policy: unsigned/signed
```

Windows x64 must not be advertised as an end-user target based only on source CI.

## System Install — disposable-host evidence

Do not run against a production gateway.

Required host:

- Linux x64;
- systemd running normally;
- no existing SlncTrZ managed roots;
- root/sudo available only for setup/lifecycle test.

Command:

```bash
sudo SLNCTRZ_E2E_ALLOW_SYSTEM=1 \
  scripts/clean-release-system-e2e.sh vX.Y.Z
```

Record:

```text
host image/version:
tag/commit:
service account created/reused:
Initial Path runtime-account readability:
service active:
healthz:
status:
doctor:
restart/reboot persistence:
default uninstall preserved state/config:
result:
```

A release must not call System Install "verified" without this evidence.

## Owner Console browser evidence

Run against the installed release.

Required flow:

1. open `/owner`;
2. login with generated Owner Passphrase;
3. verify session/CSRF;
4. verify Overview + recovery path;
5. switch Restricted → Autonomous with explicit confirmation;
6. switch back Autonomous → Restricted;
7. add/remove Path;
8. add/remove Command;
9. add/test/sync/enable/disable/remove MCP provider;
10. logout;
11. login again;
12. prove Owner-login abuse accounting is failure-only: more than ten successful logins from one peer remain successful, then ten invalid passphrases return 401 and the next attempt returns 429 with `Retry-After`.

Record local loopback HTTP and, if claimed, public HTTPS behavior separately.

```text
browser/version:
release tag/commit:
local HTTP cookie/session: PASS/FAIL
public HTTPS cookie/session: PASS/FAIL/not claimed
Autonomy:
Paths:
Commands:
MCP provider:
logout/login:
result:
```

## Core-tool release conformance

Run against the installed release:

```text
core.ping
core.read
core.search explicit-root + multiple configured Paths
core.write dryRun:true
core.write apply
core.edit dryRun:true
core.edit apply
core.exec Restricted
core.exec Autonomous where intended
cancellation/time/output guards
OAuth/provider/audit restart persistence where claimed
Task Runtime restart reset where documented
```

For the historical multi-root search bug, acceptance must prove that an explicit requested root is honored and does not search sibling authorized roots.

## Image reading and display acceptance

For a release that includes `media.read_image`, record these independently:

- `core.ping.structuredContent.media.advertisedTools` agrees with `tools/list` for callers
  with and without read authority; image help shows the limits and the client display requirement.
- PNG/JPEG content returns one image block with intact bytes, correct MIME, dimensions and SHA-256.
- Multi-root containment, documentation-only scope, protected paths, byte/pixel limits and cancellation.
- The connected model recognizes details not supplied by filename or metadata.
- The user sees/opens the image attached or embedded in the final reply, on the actual client/device.
- Unsupported client display is reported explicitly; no invented sandbox paths or public URLs.

Record:

```text
client/mode/device/date:
running gateway build commit:
invocation: media.read_image / legacy core.exec
source file bytes + SHA-256:
MCP transport and byte integrity: PASS/FAIL
model image perception: PASS/FAIL/unsupported
user-visible final-answer image: PASS/FAIL/unsupported
source-only / installed release:
result:
```

The 2026-09-08 session established ChatGPT Work final-answer image display using legacy
`core.exec` and two PNG attachments. Commit `e06abc6` separately passed isolated authenticated
MCP source tests for the new image reader. Neither proves installed-release acceptance of that
new tool. See [Images in chat](IMAGES.md).

## Managed Task Runtime release acceptance

Runner evidence:

```text
task.start returns while long command is still running
later task.get sees the same Runner task
task.wait timeout leaves task running
aborted/disconnected task.wait leaves task running
explicit task.cancel terminates the managed process tree
execution timeout -> timed_out, explicit cancel -> cancelled
Restricted task.start denial matches core.exec policy
a second authenticated client cannot inspect/cancel creator-private Runner work
```

Coordinator evidence uses at least two independently authenticated clients:

```text
Client A task.create
Client B task.list/get sees the workspace task
Client B + Client C concurrent task.claim -> exactly one winner
loser cannot complete/fail/release claimant-owned work
winner release -> another client can reclaim
claimant complete/fail -> creator sees terminal result
claimant cannot creator-cancel the task
creator can cancel available/claimed coordination work
terminal completed/failed/cancelled history is pruned deterministically at capacity
available/claimed work is never evicted; full-active capacity still fails loud
```

Also prove the documented lifecycle boundary: Task Runtime is in-memory and is not claimed to survive a gateway restart. Through the real application entry, graceful SIGTERM and SIGINT must cancel managed descendant process trees and close owned resources before exit on platforms where those handlers are available. Do not substitute explicit `task.cancel` evidence for application-shutdown evidence, and do not claim cleanup for forced termination that cannot run the handler. Coordination instructions/results are context, not authority.

## MCP provider release acceptance

For at least one real provider:

```text
add/probe
discovery
accepted canonical provider.tool namespace
tool invocation
disable -> tools disappear
enable -> tools return
sync drift path
credential failure classification
credential rotation OLD -> committed -> active runtime NEW, with failed rotation preserving OLD
stdio official legacy + modern-only protocol-era discovery/call matrix
timeout -> transport restart -> next normal stdio call succeeds; late old-child events do not kill new generation
restart persistence
```

First-class SlncTrZ providers should follow `MCP_PROVIDER_STANDARD.md`. Generic third-party MCP servers are not required by the MCP protocol itself to implement the SlncTrZ `help` convention.

## ChatGPT real-client evidence

Only mark ChatGPT verified for the release after recording:

```text
client build/date:
release tag/commit:
public HTTPS MCP URL:
OAuth registration/authorization:
owner approval:
tool discovery:
core.ping:
core.read/search:
write/edit preview:
write/edit apply:
core.exec policy behavior:
restart/reconnect:
MCP provider tool:
result:
```

Do not use a source checkout as the sole evidence.

## Claude real-client evidence

Record the equivalent flow independently:

```text
client build/date:
release tag/commit:
MCP/OAuth connection mode:
owner approval where applicable:
tool discovery:
core.ping:
core.read/search:
write/edit preview/apply:
core.exec policy behavior:
restart/reconnect:
MCP provider tool:
result:
```

Client-specific behavior belongs in release evidence/docs, not in a weakened gateway security contract.

## Update/rollback evidence

Use two public/controlled release candidates:

```text
install A
configure Paths/Commands/provider/passphrase
update to B through hosted manifest + redirects
verify B active/running
verify state preserved
rollback to A
verify A active/running
verify compatible state preserved
```

Record both release hashes and installed/running identity.

## Doctor/repair fault injection

At minimum:

| Fault                           | Doctor expected                | Repair expectation                 |
| ------------------------------- | ------------------------------ | ---------------------------------- |
| active binary tamper            | FAIL integrity                 | no silent binary overwrite         |
| invalid policy                  | FAIL policy                    | preserve customer policy           |
| invalid command catalog         | FAIL catalog                   | preserve invalid existing file     |
| missing minimal command catalog | FAIL catalog                   | repair may restore minimal catalog |
| unsafe Owner Passphrase mode    | FAIL permissions               | repair may restore private mode    |
| missing Owner Passphrase        | FAIL missing                   | repair must not regenerate         |
| inaccessible Path               | FAIL OS permission             | explicit OS/path action            |
| stopped service                 | FAIL/WARN reachability by mode | explicit restart action            |
| installed/running mismatch      | FAIL mismatch                  | restart before lifecycle changes   |

## Uninstall/reinstall evidence

Default uninstall:

- program/service removed;
- config/state preserved;
- unrelated paths untouched.

Purge:

- explicit destructive confirmation;
- program/config/state/credentials removed according to contract.

Reinstall after default uninstall must be able to reuse preserved state intentionally.

## Final claim rule

A support claim is limited to evidence actually collected for that release.

Missing evidence does not get converted into PASS from code inspection. Either collect it or narrow the claim.

## v0.3.0 coding harness release acceptance

- Global-only context works when the project has no AGENTS.md; optional project roots obey policy.
- context.bootstrap returns global/product instructions and catalog metadata without skill bodies.
- skills.read returns instructions on activation and resources only when explicitly requested.
- Core/image/task/provider calls reject absent, cross-client or stale receipts before effects.
- A rejected execution does not append/write/start anything; recovery executes the request once.
- MCP argument and request-metadata delivery work over authenticated legacy and modern HTTP.
- YAML errors, symlinks, protected paths, traversal and budgets cannot bypass context boundaries.
- Installing/upgrading preserves global preferences and intentional skill removals.
- The standalone binary includes starter skills and provisions them without a source checkout.
- Help, MODEL_GUIDE and coding-agent integration explain bootstrap and host context ownership.
- All repository gates and native release gates remain required. Local Linux evidence does not
  replace Windows-native or clean-host acceptance. Do not publish until those gates pass.

## v0.3.1 usage telemetry and large-skill release acceptance

A v0.3.1 public claim requires all normal release gates plus evidence for the following:

- a valid `SKILL.md` around 192 KiB is discovered/read successfully and a file beyond the 256 KiB hard limit remains rejected;
- telemetry enabled vs disabled produces the same MCP semantic response and side effects for representative core, task, harness, media, and provider operations;
- an observer that throws and a disposable environment with usage persistence failure do not fail or replay the MCP operation;
- `usage.sqlite3` contains only the reviewed numeric/classification schema and representative secret-bearing tool payloads are absent from the database bytes;
- usage retention and in-memory queueing remain bounded;
- `/owner/api/usage/*` returns 401 without an Owner session, rejects invalid ranges, and returns only aggregates when authenticated;
- the Owner cookie remains `Path=/owner`; `/usage` does not introduce another credential or session system;
- the automated `usage-browser-acceptance` job installs the exact public prerelease candidate and a real Chromium session renders `/usage`, signs in through the Owner flow, changes 24h/7d/30d/all ranges, shows non-empty tool breakdown and harness savings from numeric-only telemetry fixtures, and calculates custom-price estimates without a CDN dependency;
- dashboard text identifies `utf8-bytes-v1` as an estimate and explicitly excludes webchat prompts, hidden reasoning, ordinary model replies, and exact provider billing;
- restart preserves usage history while existing in-memory task/context receipt restart semantics remain unchanged;
- backup/troubleshooting/security docs describe `usage.sqlite3` separately from `audit.sqlite3`;
- README/User Guide describe the product for human users and do not convert internal test maturity into an independent security certification claim.

Do not publish v0.3.1 until supported-platform source/SEA/clean-install gates and real-client evidence required by the claimed targets are complete.

## v0.3.2 provider recovery and Owner Console acceptance

A v0.3.2 public claim requires all normal release gates plus evidence for the following reliability contract:

- a legacy Streamable HTTP provider with a valid MCP session that receives `POST /mcp -> 404` is classified internally as an invalid session rather than an undifferentiated provider crash;
- the tool call that observes the stale session fails once and is **never replayed automatically**, including write/execute-class provider tools;
- provider-local recovery clears the stale session and performs a fresh handshake for that provider only;
- historical v0.3.2 behavior: a successful recovery reset the per-incident restart budget for later independent incidents; v0.3.5 supersedes this as a complete current contract by adding the rolling cross-incident invalid-session budget described below;
- repeated restart failures within one incident remain bounded by `maxRestarts` and fail closed by quarantining the provider;
- an ordinary upstream `5xx`, authentication failure, or protocol/tool declaration failure is not misclassified as successful stale-session recovery;
- a provider that is temporarily unavailable during gateway startup receives bounded background recovery without requiring Owner Console Sync;
- a two-provider regression proves automatic recovery of provider A does not restart or mutate provider B;
- process-local counters distinguish invalid-session observations, recovery success, and recovery failure without labels or payload content that could expose provider names, credentials, arguments, or results;
- Owner Console sessions use a 3-hour sliding idle deadline capped by a 12-hour absolute deadline, prune expired records, preserve `Secure`/`HttpOnly`/`SameSite=Strict`/`Path=/owner`, and Sign out revokes only the current Owner session;
- the installed `/owner` artifact presents Commands and MCP operational health in Overview, keeps detailed runtime metadata under collapsed Advanced, and preserves existing CSRF and mutation behavior.

The v0.3.2 release does **not** claim generation-local activation for Owner-driven provider configuration mutations. Add/Enable/Disable/Sync/credential activation may still rebuild the policy/runtime generation; this is separate from the provider-local automatic fault-recovery path above and remains a future scalability optimization.

For **v0.3.5 and later**, the historical v0.3.2 sentence that a successful stale-session recovery fully resets lifetime incident pressure is superseded. Acceptance must also prove the current rolling `provider_session_invalid` incident budget: with a configured budget of two inside one rolling window, two incidents may recover, the third quarantines without replay, post-quarantine calls are not dispatched, and incidents older than the window expire instead of causing permanent quarantine.
