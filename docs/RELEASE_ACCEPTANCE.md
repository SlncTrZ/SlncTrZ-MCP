# Release Acceptance Evidence

This document defines the evidence format for a SlncTrZ-MCP public release. It is not a claim that every item below has already passed.

## Automated Linux x64 candidate evidence

Produced by `.github/workflows/standalone.yml`:

- Node 22/24 quality gate;
- public docs contract;
- production dependency audit;
- Linux x64 SEA build;
- binary help/version/build-info;
- checksum + manifest projection;
- version/tag/build identity gate;
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
signing policy: unsigned/signed
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
11. login again.

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
restart persistence
```

For the historical multi-root search bug, acceptance must prove that an explicit requested root is honored and does not search sibling authorized roots.

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
