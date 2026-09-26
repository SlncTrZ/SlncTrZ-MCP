# Deployment

This document describes the current deployment contract for SlncTrZ-MCP.

## Deployment modes

### User Install

Default locations:

```text
install: ~/.local/share/slnctrz-mcp
state:   ~/.slnctrz-mcp
config:  ~/.config/slnctrz-mcp
```

User mode does not install a system service. The generated launcher is:

```text
<installRoot>/slnctrz-mcp-launcher
```

Start it with the generated config file:

```bash
SLNCTRZ_CONFIG_FILE="$HOME/.config/slnctrz-mcp/gateway.env" \
  "$HOME/.local/share/slnctrz-mcp/slnctrz-mcp-launcher"
```

### User Install — Windows x64

Windows x64 User Install uses Git Bash only for the bootstrap. The installed runtime is native Windows.

Default locations:

```text
install: %LOCALAPPDATA%\SlncTrZ-MCP
state:   %USERPROFILE%\.slnctrz-mcp
config:  %APPDATA%\SlncTrZ-MCP
launcher: %LOCALAPPDATA%\SlncTrZ-MCP\slnctrz-mcp.exe
```

Run the public `install.sh` from Git Bash. The bootstrap converts MSYS paths with `cygpath -w`, verifies the Windows artifact, and runs native setup. After setup, Git Bash, Node.js, npm, and a repository checkout are not required.

Windows System Install/service mode is not currently supported.

### System Install — Linux

Default locations:

```text
install: /opt/slnctrz-mcp
state:   /var/lib/slnctrz-mcp
config:  /etc/slnctrz-mcp
service: slnctrz-mcp.service
account: invoking OS user (validated SUDO_USER when setup runs through sudo)
```

System setup requires root/sudo and an operational systemd service manager, but privileged authority is used only for system installation operations. The runtime identity is the real non-root user that invoked setup; under `sudo`, setup validates and resolves `SUDO_USER`, renders that user/group into the systemd unit, verifies the user can read and write the Initial Path, installs the unit, enables/starts it, and health-checks the gateway. No dedicated `slnctrz` account is created. Linux hosts without operational systemd should use User Install/foreground mode instead of pretending System Install succeeded.

The runtime process must not run as root. The generated systemd unit also carries the runtime PATH used for command discovery so Restricted catalog provisioning and later strict runtime compilation resolve against the same command search path. Updating a legacy System Install re-renders the unit before restart, so an older `User=slnctrz` service is migrated to the validated invoking user without changing the persisted installation metadata schema or rewriting owner-managed `command.json`.

## Local mode

Local mode is the default:

```text
SLNCTRZ_HOST=127.0.0.1
SLNCTRZ_PORT=3100
no SLNCTRZ_PUBLIC_URL
```

Derived URLs:

```text
http://127.0.0.1:3100/mcp
http://127.0.0.1:3100/owner
```

Local loopback OAuth/Owner Console HTTP is allowed. This exception is only for loopback use.

## Public mode

Public mode is selected by setting a public URL such as:

```text
SLNCTRZ_PUBLIC_URL=https://mcp.example.com/mcp
```

Requirements:

- scheme must be HTTPS;
- path must be exactly `/mcp`;
- no userinfo, query, or fragment;
- the reverse proxy/tunnel must forward to the configured local listener;
- the public hostname must be present in the configured Host allowlist;
- when the Owner Console is enabled publicly, the public hostname must also be present in the Origin allowlist.

Host and Origin validation run before Owner Console, OAuth, and MCP application dispatch. `/healthz` and `/readyz` are intentionally usable without the Origin gate.

The gateway can still bind to `127.0.0.1:3100` behind a reverse proxy. Public URL describes the externally advertised MCP/OAuth identity; it does not force the process to bind directly to the public interface.

## Reverse proxy

Recommended shape:

```text
Internet client
  -> HTTPS reverse proxy / tunnel
  -> 127.0.0.1:3100
  -> SlncTrZ-MCP
```

Forward the original Host correctly and terminate TLS at the trusted public edge. Do not expose the loopback control plane (default port 3101) through the proxy. Owner failed-authentication accounting intentionally uses the direct socket peer and does not trust forwarding headers. Behind a shared tunnel/proxy, multiple clients can therefore share one bounded failure bucket; once that bucket is exhausted, the peer fails closed until the window resets. This preserves the pre-KDF CPU-abuse cutoff. If per-client edge rate limiting is required, enforce it at a trusted proxy/edge rather than teaching the gateway to trust forwarded client-IP headers implicitly.

Public routes include:

```text
/mcp
/owner
OAuth metadata/authorization routes
/healthz
/readyz
```

The control plane is separate and loopback-only.

## Release/update trust boundary

Fresh installation starts with a bootstrap trust problem: the installer/bootstrap binary must itself be obtained through a trusted HTTPS/release path. Once a signing-enabled standalone binary is active, setup/update requires `manifest.json` plus `manifest.json.sig`, verifies the Ed25519 publisher signature over the exact manifest bytes before parsing, and only then accepts artifacts whose declared size and SHA-256 match.

The release-signing private key is **not** deployed to the gateway host. Official CI references the protected GitHub `release-signing` Environment; production acceptance must verify that this Environment was pre-created, restricted to `v*` tags, requires review with self-review/bypass protections, and owns the only `SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64` secret. Runtime config/state must never contain that private key.

## Initial Path

Setup requires an existing readable Path.

User mode defaults to the setup process current working directory if `--path` is omitted. For predictable installation, pass `--path` explicitly.

System mode requires an explicit Path. Setup additionally checks read and write access as the resolved invoking runtime user before enabling the service.

Gateway authorization does not replace OS permissions. A configured Path that the runtime account cannot traverse/read will still fail.

## Authority modes

### Restricted

- built-in file tools stay within configured Paths;
- `core.exec` requires an approved command catalog entry;
- `task.start` uses the same command/Path authority as `core.exec`;
- fresh setup loads the platform candidate template (`commands.json` on Linux, `commands.win32.json` on Windows), filters out executables unavailable to the runtime user, persists only the usable subset, and then compiles it strictly;

### Autonomous

- core tools may use any path/executable available to the gateway OS account;
- `task.start` follows the same OS-user execution authority.

Neither mode elevates the OS account by itself. Logical coordination tasks do not widen either mode; their instructions/results are context only.

## Task Runtime lifecycle

Managed Runner and Coordinator state is intentionally in-memory in the current product. It survives later MCP requests only while the same gateway process remains running. On graceful SIGTERM/SIGINT shutdown the application stops accepting new work, cancels active Runner process trees, retires provider generations and closes listeners/audit resources before exit. Restart, update, rollback or service replacement clears active task state; clients must not treat task IDs as durable recovery handles across a restart. Do not claim graceful cleanup for SIGKILL/TerminateProcess-style termination that prevents the shutdown handler from running.

## Runtime config

Normal product configuration should use:

```bash
slnctrz-mcp config show
slnctrz-mcp config set port 3200
slnctrz-mcp config set host 127.0.0.1
slnctrz-mcp config set public-url https://mcp.example.com/mcp
slnctrz-mcp config set public-url local
slnctrz-mcp config set owner-console true
```

Generated `gateway.env` is private and contains only the supported runtime keys. Do not add arbitrary shell code; the launcher parses a strict allowlist and does not `source` or `eval` the file.

## Health endpoints

```text
GET /healthz
GET /readyz
```

`/healthz` is process liveness.

`/readyz` verifies that the active policy snapshot can be captured. A failure returns 503 rather than claiming readiness.

## Owner Console exposure

The Owner Console is enabled by default for normal local setup.

Treat the Owner Passphrase as an administrative secret. For public deployment:

- use HTTPS;
- keep the passphrase private;
- do not publish the loopback control port;
- review `SECURITY.md` and `docs/THREAT_MODEL.md`.

## Release runtime

The supported standalone model uses self-contained native SEA binaries for Linux x64 and Windows x64, immutable version directories, and an atomic `current.json` activation record.

The production systemd service resolves the active SEA through the generated launcher. It does not depend on `dist/`, a repository checkout, or `/usr/bin/node`.

## Developer runtime

Source development is a separate deployment model:

```bash
npm ci
npm run build
npm start
```

It requires Node `>=22.13.0 <25`. Do not confuse developer/source deployment with the standalone end-user service contract.

## Coding harness state

v0.3.1 discovers `<stateRoot>/harness/AGENTS.md` and `<stateRoot>/harness/skills/` automatically.
These are editable persistent files, separate from embedded product guidance and versioned
release binaries. `SLNCTRZ_HARNESS_ROOT` in gateway.env can select another absolute root. Ensure
that root is accessible to the existing runtime account; it does not change Paths or commands.

Refresh client tool discovery after upgrading. Work calls require `context.bootstrap` receipts.
Receipts are in-memory and expire after four hours; restart requires another bootstrap. Agent
hosts retain their own conversation and model loop. See [CODING_AGENTS.md](CODING_AGENTS.md).
