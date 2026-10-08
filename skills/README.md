# SlncTrZ skills

Skills use `skills/<name>/SKILL.md` with Agent Skills YAML frontmatter.

## Bundled Installed Defaults

The native build and fresh harness provisioning currently include:

- code-review/SKILL.md
- debug-and-test/SKILL.md
- debug-and-test/references/regression-checks.md

Setup/first start writes defaults once to `<stateRoot>/harness/skills/` without overwriting
owner files. An initialized harness is not automatically expanded with all repository skills.

## Additional Repository Skills

The repository also contains architectural-planning, context-slicing, invariant-check,
repo-recon, superpowers and render-technical-video plus its referenced resources.
They are available through an authorized projectRoot's skills discovery or by explicit owner
installation into the configured global harness. Their presence in Git does not mean that
the SEA embeds or seeds them. Copy the whole skill directory when installing referenced resources.

## Progressive Loading

context.bootstrap returns metadata only; skills.read activates SKILL.md and then loads
referenced text resources on demand. The running gateway discovers its configured harness,
not an arbitrary development checkout. Project discovery also supports .agents/skills.

Instructions remain guidance and do not authorize commands or external providers.
See [Harness](../docs/HARNESS.md) for paths, revision checks and size limits.
