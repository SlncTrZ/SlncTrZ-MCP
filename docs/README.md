# Documentation

Start with the guide for your task. The README introduces the product; the User Guide explains
everyday use. Technical references explain the implementation without replacing those guides.

| You need to…                                  | Read                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Install and connect your first client         | [User Guide](USER_GUIDE.md)                                                                              |
| Connect a coding agent with native OAuth      | [Gateway-only](GATEWAY_ONLY.md)                                                                          |
| Set up HTTPS or a service                     | [Deployment](DEPLOYMENT.md)                                                                              |
| Add a provider                                | [MCP Servers](../MCP_SERVERS.md)                                                                         |
| Add instructions or custom skills             | [Harness](HARNESS.md)                                                                                    |
| Integrate a Full coding harness               | [Coding Agents](CODING_AGENTS.md)                                                                        |
| Share an image with your agent                | [Images](IMAGES.md)                                                                                      |
| Diagnose a problem                            | [Troubleshooting](TROUBLESHOOTING.md)                                                                    |
| Preserve or restore your data                 | [Backup and Restore](BACKUP_RESTORE.md)                                                                  |
| Understand permissions                        | [Autonomy](AUTONOMY.md), [Security](../SECURITY.md), [Threat Model](THREAT_MODEL.md)                     |
| Develop the project                           | [Contributing](../CONTRIBUTING.md), [Engineering](../ENGINEERING.md), [Architecture](../ARCHITECTURE.md) |
| Check current source/release/runtime evidence | [Project Status](PROJECT_STATUS.md), [QA report](../QA_QC_REPORT_v0.4.1.md)                              |
| Review priorities                             | [Product Plan](../PLAN.md)                                                                               |
| Prepare a release                             | [Release Process](../RELEASE.md), [Acceptance](RELEASE_ACCEPTANCE.md)                                    |
| Inspect dependency origins                    | [Provenance](../PROVENANCE.md)                                                                           |
| Understand a past design decision             | [Architecture decisions](adr/README.md)                                                                  |
| Inspect lifecycle ledger wiring               | [Lifecycle Wiring](LIFECYCLE_WIRING.md)                                                                  |
| Give an agent operational guidance            | [Model Guide](MODEL_GUIDE.md)                                                                            |

Current guides were reconciled on 2026-10-09 against published v0.4.2 and the development
tree's source contracts. Start with the [OS installation steps](USER_GUIDE.md#1-installation--endpoints),
then [AI Web](USER_GUIDE.md#connect-an-ai-web-client) or [coding-agent recipes](GATEWAY_ONLY.md).
The [client evidence matrix](CODING_AGENTS.md#client-evidence-matrix) marks help checks and
documentation recipes separately from end-to-end acceptance.

Additional repository skills are not all embedded defaults; the lifecycle ledger is not
wired into live controllers.
See [Harness](HARNESS.md) and [Lifecycle Wiring](LIFECYCLE_WIRING.md).

Release notes and architecture decisions retain historical behavior. A note marked superseded
describes a past contract. Current guides identify unreleased changes explicitly; a source
implementation or automated test result alone does not establish installed-client support.
