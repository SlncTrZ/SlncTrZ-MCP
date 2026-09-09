# SlncTrZ skills

Each skill uses `skills/<name>/SKILL.md` with Agent Skills YAML frontmatter. This repository
contains the bundled code-review and debug-and-test skills. The standalone build embeds these
files; first setup/start seeds them into `<stateRoot>/harness/skills/` without overwriting existing
files. The running gateway discovers that configured global root, not this development checkout.

Catalog metadata is delivered by context.bootstrap. Full instructions and text resources are
read through skills.read on demand. See [the harness guide](../docs/HARNESS.md).
