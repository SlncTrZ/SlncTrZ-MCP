# SlncTrZ-MCP

**Owner-controlled access from Web AI to your Linux or Windows machine — files, commands, Agent Skills, tasks, and MCP servers through one gateway.**

SlncTrZ-MCP is a self-hosted control and execution layer for people who want ChatGPT, Claude, Gemini, Grok, coding agents, and other Web AI clients to work with the machine where their files and projects actually live without giving every client a different pile of scripts, credentials, and filesystem access.

We built it around a simple idea:

> AI should be useful on the machine where your work actually lives, but the owner should remain the authority boundary.

It is more than an MCP proxy. SlncTrZ-MCP gives Web AI one owner-controlled endpoint for files, commands, Agent Skills, managed tasks, images, and additional MCP servers. You decide what the gateway can reach. The agent does not get an admin backdoor just because it can call tools.

[▶ Watch the introduction & setup video](docs/SlncTrZ-MCP.mp4)

---

## Why this exists

Most MCP setups become fragmented quickly: one client has filesystem access, another has shell access, a third has a different MCP server list, and every connection has its own credentials and assumptions.

We wanted one place to answer four questions:

1. **What can the AI read or change?**
2. **What commands may it start?**
3. **Which extra MCP servers are available?**
4. **What working context and skills should every coding agent receive?**

SlncTrZ-MCP puts those answers behind one owner-controlled gateway.

### What you get

- **One MCP endpoint** for multiple AI clients.
- **Restricted or Autonomous authority** depending on how much OS access you want to grant.
- **Files + search + write/edit + command execution** through a small stable core tool surface.
- **Global `AGENTS.md` + Agent Skills** with progressive disclosure instead of eagerly loading every instruction file.
- **Managed runner and coordination tasks** for longer or multi-agent work.
- **Extra MCP servers behind one namespace** such as `kb.search`, `github.issue`, or any provider you add.
- **Owner Console** for Paths, Commands, MCP Servers, authority, and operation.
- **`/usage` dashboard in v0.3.1** for observed gateway traffic, per-tool context cost, progressive-disclosure savings, and estimated cost avoided.
- **Metadata-only audit history** and a separate privacy-minimal usage ledger.
- **Standalone Linux and Windows builds** so the installed gateway does not need a source checkout or Node.js runtime.

---

## What makes it different

### The model is not the authority

Connected models can use what the owner grants. They cannot create their own Paths, approve new Commands, reveal managed MCP credentials, or turn guidance text into permissions.

The real boundary is:

```text
Authentication
    ↓
Owner policy
    ↓
Kernel capability checks
    ↓
Files / Commands / Tasks / MCP providers
```

`AGENTS.md`, skills, prompts, and task text are context. They are **not** authorization.

### Coding context is loaded progressively

A coding agent starts with global instructions and a compact skill catalog. It reads a full `SKILL.md` only when the skill is actually relevant, then reads referenced resources on demand.

That matters because a mature skill library can become larger than the task itself. v0.3.1 raises the bounded `SKILL.md` limit to **256 KiB** while keeping progressive disclosure, so large high-quality skills are supported without injecting all of them into every turn.

### We measure the cost of that context

`/usage` does not pretend to know your entire ChatGPT or Claude bill. It measures the part SlncTrZ actually sees:

- request bytes entering the MCP gateway;
- response bytes leaving the gateway;
- estimated tokens for that traffic;
- which tools account for the traffic;
- how much Agent Skill context was avoided by not eager-loading every active skill.

The dashboard never needs your webchat prompt or normal model reply. Dollar savings are clearly labeled estimates and use the input-token price you enter locally in the browser.

### Security work is part of the product, not a footnote

We have spent more engineering time than our current community size would suggest on containment, immutable releases, OAuth, bounded work, provider isolation, metadata-only audit, context receipts, rollback, repair boundaries, and cross-platform acceptance.

That does **not** mean the project is “proven secure” or independently audited. It means the architecture now has explicit security invariants and substantial automated evidence behind them. Read [SECURITY.md](SECURITY.md) and [the threat model](docs/THREAT_MODEL.md) before exposing a gateway publicly.

---

## Where the project is today

The engineering is ahead of the community.

We consider the core safety model, architecture, release model, and extension path mature enough to put in front of more real users. The weak point today is adoption: SlncTrZ-MCP is still a small project with very limited stars, forks, third-party integrations, independent review, and community testing.

We are not going to hide that behind marketing language. v0.3.2 focuses on provider recovery and Owner Console reliability while retaining the usage visibility and clearer product surface introduced in v0.3.1.

If the idea is useful to you, the most valuable contributions right now are straightforward: **try it, break it, report what is confusing, open issues, review the security model, and tell us which clients or workflows need better support.**

---

## Quick start

### Linux x64

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME"
```

### Windows x64 with Git Bash

Install **Git for Windows**, open **Git Bash**, then run the same bootstrap:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/SlncTrZ/SlncTrZ-MCP/releases/latest/download/install.sh \
  --output /tmp/slnctrz-install.sh

sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME"
```

Git Bash is only the installer bootstrap. The installed Windows runtime is a native `slnctrz-mcp.exe`; it does not need Git Bash, Node.js, npm, or the repository afterward.

Default Windows User Install locations:

```text
Program: %LOCALAPPDATA%\SlncTrZ-MCP
State:   %USERPROFILE%\.slnctrz-mcp
Config:  %APPDATA%\SlncTrZ-MCP
```

### Linux system install

```bash
sudo sh /tmp/slnctrz-install.sh \
  --mode system \
  --port 3100 \
  --path /srv/slnctrz-workspace
```

System mode uses root only for privileged installation steps. The gateway runs as the validated invoking OS user rather than a new `slnctrz` account.

---

## After installation

A successful first setup prints the information you actually need:

- installed version and mode;
- MCP endpoint;
- Owner Console URL;
- Owner Passphrase on first creation and its recovery-file path;
- OAuth Client ID and generated Client Secret when applicable;
- install, state, and config locations.

Local defaults look like:

```text
MCP endpoint:  http://127.0.0.1:3100/mcp
Owner Console: http://127.0.0.1:3100/owner
Usage:        http://127.0.0.1:3100/usage
```

Open `/owner`, sign in, and review:

| Control         | What it means                                                          |
| --------------- | ---------------------------------------------------------------------- |
| **Autonomy**    | Restricted or Autonomous runtime authority                             |
| **Connections** | Existing OAuth grants and their Full/Gateway-only tool-surface profile |
| **Paths**       | Filesystem roots available to built-in file tools in Restricted mode   |
| **Commands**    | Executables `core.exec` may start in Restricted mode                   |
| **MCP Servers** | Extra local or remote MCP providers exposed through the gateway        |

Restricted is the recommended starting point.

The normal Connections UI changes the profile of an existing grant. A separate advanced
compatibility command remains available for clients that need a default for **future**
grants:

```bash
slnctrz-mcp owner client-default <client-id> <full|gateway-only>
```

That client default is persisted, snapshots into newly issued grants, and does not mutate
the profile of existing grants. It is intentionally not exposed as the normal row-level
Connections action.

> Restricted mode is not a full OS sandbox. If you approve Bash, Python, Node, PowerShell, Docker, `sudo`, or another general-purpose tool, that child process can exercise the OS permissions of the account running the gateway.

---

## Local or public

You do **not** need a domain just to use SlncTrZ locally.

Use a public HTTPS URL only when a cloud-hosted AI client must reach your machine:

```bash
sh /tmp/slnctrz-install.sh \
  --mode user \
  --port 3100 \
  --path "$HOME" \
  --public-url https://mcp.example.com/mcp
```

The public URL must be HTTPS and end at `/mcp`. See [Deployment](docs/DEPLOYMENT.md) for reverse proxy and TLS guidance.

---

## Connect an AI client

Point the client at your MCP endpoint. SlncTrZ-MCP handles OAuth and owner approval.

After connection, clients should call:

```text
core.ping
context.bootstrap
```

`core.ping` is the orientation/recovery tool. `context.bootstrap` gives the coding agent its global instructions, optional project context, skill catalog, and a short-lived context receipt required by ordinary work calls.

### Client notes

- **ChatGPT / Grok:** dynamic registration + PKCE; no static Client Secret is normally required.
- **Claude:** configure the static Client ID/Secret and complete OAuth before Owner approval.
- **Gemini Spark:** the current compatibility flow may require opening the `oauth-redirect.googleusercontent.com/r/...` network request in a new tab after one Owner approval. See [User Guide](docs/USER_GUIDE.md) for the exact safe procedure.

Real-client compatibility claims are release-evidence based. We do not mark a client as verified for a release only because the protocol looks compatible on paper.

---

## Coding harness

The harness is deliberately small:

| Tool                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `context.bootstrap` | Load global + optional project instructions and the compact skill catalog |
| `context.close`     | Release an in-memory context receipt                                      |
| `skills.list`       | Re-read active skill metadata                                             |
| `skills.read`       | Load one skill or one referenced text resource on demand                  |

Global defaults live under:

```text
<stateRoot>/harness/AGENTS.md
<stateRoot>/harness/skills/<skill-name>/SKILL.md
```

Project overlays are optional. A project can provide `AGENTS.md`, `.agents/skills/`, or `skills/` when explicit project context is requested.

### v0.3.1 skill limits

```text
AGENTS.md      32 KiB per file
SKILL.md       256 KiB
YAML metadata   8 KiB
Skill resource  1 MiB on demand
Active skills   128
```

These are hard bounds, not token-budget suggestions. See [Harness](docs/HARNESS.md).

---

## `/usage`: see what the gateway is costing and avoiding

v0.3.1 adds a read-only usage dashboard at:

```text
/usage
```

The page reuses the existing Owner Console session for data access. The Owner cookie remains scoped to `/owner`; usage APIs live under `/owner/api/usage/*`.

The dashboard shows:

- total measured MCP traffic;
- gateway → client estimated tokens;
- client → gateway estimated tokens;
- usage by tool;
- 24h / 7d / 30d / all-time charts within retained history;
- potential eager Agent Skill context;
- actually disclosed skill context;
- avoided context and reduction percentage;
- estimated cost avoided at a custom input price per 1M tokens.

### What `/usage` does not measure

It does not see or claim to measure:

- the user's full webchat prompt;
- system/developer prompts owned by the chat platform;
- hidden reasoning;
- the model's normal chat answer;
- exact OpenAI/Anthropic/Google billing tokens.

The token estimator is versioned and model-neutral. v0.3.1 uses `utf8-bytes-v1` (roughly four UTF-8 bytes per token). Exact byte counts are the ground truth; token and dollar values are estimates.

Usage history is stored separately in:

```text
<stateRoot>/usage.sqlite3
```

It stores numeric/classification metadata, not prompts, arguments, file contents, command output, provider payloads, credentials, bearer tokens, or context receipts. Telemetry is fail-open: if usage persistence fails, normal MCP work continues.

---

## Core tools

| Tool               | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `core.ping`        | Runtime status, authority, Paths, providers, docs, recovery orientation |
| `core.read`        | Read UTF-8 files                                                        |
| `core.search`      | Search files and directories                                            |
| `core.write`       | Atomic write; `dryRun:true` previews                                    |
| `core.edit`        | Exact-match edit; `dryRun:true` previews                                |
| `core.exec`        | Run approved/native commands under bounded execution rules              |
| `media.read_image` | Read PNG/JPEG under existing file-read authority when advertised        |

SlncTrZ intentionally does not expose `owner.*` tools to the model.

---

## Managed tasks

Runner tasks execute commands asynchronously using the same authority as `core.exec`:

```text
task.start -> task.get / task.wait -> task.cancel
```

Coordination tasks let authenticated clients share logical work inside a workspace:

```text
task.create -> task.list / task.get -> task.claim
            -> task.release | task.complete | task.fail
```

Current task state is **in-memory only** and does not survive a gateway restart. Task text never grants additional filesystem or command authority.

---

## Add other MCP servers

The Owner Console can register local stdio or remote Streamable HTTP MCP providers. Their tools are exposed under a stable namespace:

```text
<provider>.<tool>
```

Credentials stay in managed secret storage rather than being copied into model-visible manifests.

See [MCP Servers](MCP_SERVERS.md) and [Provider Standard](MCP_PROVIDER_STANDARD.md).

---

## Operate and recover

```bash
slnctrz-mcp status
slnctrz-mcp doctor
slnctrz-mcp config show
slnctrz-mcp update
slnctrz-mcp rollback
slnctrz-mcp repair
slnctrz-mcp owner rotate-passphrase
```

`doctor` is read-only. `repair` is intentionally bounded and does not silently replace owner credentials or customer policy. Updates activate verified immutable releases; rollback returns to an already verified prior release.

Default uninstall preserves customer state:

```bash
slnctrz-mcp uninstall --yes
```

Use `--purge` only when you really want program, config, state, usage history, audit history, skills, and credentials removed.

See [Backup and Restore](docs/BACKUP_RESTORE.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

---

## Security model in plain language

The most important properties are:

- owner configuration is not exposed as model-facing MCP tools;
- Restricted file operations stay inside configured canonical Paths;
- Restricted command starts use the owner-managed command catalog;
- Autonomous mode deliberately follows the OS permissions of the gateway account;
- secret paths are denied by kernel rules;
- provider credentials are separated from provider manifests and model output;
- context receipts are workflow state, never authorization;
- audit is metadata-only by schema;
- usage telemetry is separate, metadata-only, bounded, and fail-open;
- after the signing-enabled trust bootstrap, updater/setup manifests are publisher-authenticated with an embedded Ed25519 trust root before parsing, then artifacts are verified by declared size/SHA-256 before activation;
- policy/provider generations activate atomically rather than partially mutating the live runtime.

No software of this kind should be described as risk-free. SlncTrZ-MCP can intentionally launch powerful commands when the owner allows them, and Autonomous mode can be as powerful as the OS account running it. Our goal is to make those boundaries explicit, inspectable, and difficult to bypass accidentally.

---

## Supported targets

### Source / development

| Environment       | Status           |
| ----------------- | ---------------- |
| Linux + Node 22   | CI target        |
| Linux + Node 24   | CI target        |
| Windows + Node 24 | Native CI target |
| Node contract     | `>=22.13.0 <25`  |

### Prebuilt installs

| Target                     | Status                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Linux x64 standalone SEA   | Public release target                                           |
| Linux x64 User Install     | Release-gated clean-host acceptance                             |
| Linux x64 System Install   | Implemented; support claim requires clean systemd-host evidence |
| Windows x64 standalone SEA | Public release target                                           |
| Windows x64 User Install   | Git Bash bootstrap + native runtime; release-gated acceptance   |
| Windows System Install     | Not supported yet                                               |
| macOS prebuilt installer   | Not a public target yet                                         |

A source compile is not treated as an end-user support claim.

---

## Documentation for people running the product

- [User Guide](docs/USER_GUIDE.md) - first setup, clients, Paths, MCP servers, `/usage`
- [Deployment](docs/DEPLOYMENT.md) - local, system, reverse proxy, public HTTPS
- [Troubleshooting](docs/TROUBLESHOOTING.md) - diagnosis and recovery
- [Backup and Restore](docs/BACKUP_RESTORE.md) - what state matters and how to recover it
- [Security](SECURITY.md) - security contract
- [Threat Model](docs/THREAT_MODEL.md) - threats, controls, residual risk
- [Architecture](ARCHITECTURE.md) - how the implementation is split internally
- [Harness](docs/HARNESS.md) - AGENTS/skills/context behavior and limits
- [Release](RELEASE.md) - how official artifacts are built and promoted
- [Release Acceptance](docs/RELEASE_ACCEPTANCE.md) - evidence required before support claims

`docs/MODEL_GUIDE.md` is different on purpose: it is the compact guide surfaced to connected AI clients. The README and operator docs are written for people.

---

## Help us turn engineering into a community

SlncTrZ-MCP does not need more claims. It needs more users and more independent evidence.

Useful contributions include:

- install it on a machine we have not tested;
- connect a client we do not use;
- report confusing setup or OAuth steps;
- challenge the threat model;
- contribute Agent Skills;
- add provider integrations;
- benchmark context/usage behavior;
- improve docs and screenshots;
- review code and release artifacts.

If you find the project useful, a star helps other people discover it. A fork, issue, test report, or serious review is even more valuable.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [ENGINEERING.md](ENGINEERING.md).

---

## Development

Requires Node `>=22.13.0 <25`.

```bash
npm ci
npm run check
npm run build
```

## License

Apache-2.0. See [LICENSE](LICENSE).
