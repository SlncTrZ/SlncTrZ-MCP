/**
 * Harness Provisioning — seed editable global configuration once, preserving owner changes.
 * Wing: context | Topic: installation | Updated: 2026-09-09
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveApplicationRoot } from "../owner/managed-state.js";
import { isStandaloneSeaRuntime, readStandaloneTextAsset } from "../standalone/assets.js";
import { assertContextPath } from "./discovery.js";

export const BUNDLED_SKILL_FILES = [
  "skills/code-review/SKILL.md",
  "skills/debug-and-test/SKILL.md",
  "skills/debug-and-test/references/regression-checks.md"
] as const;

const DEFAULT_GLOBAL_INSTRUCTIONS = `# Global coding instructions

These preferences apply to work through this SlncTrZ installation across projects.
Edit this file to set your language, coding conventions and working preferences.
Project AGENTS.md files are optional contextual additions. Surface conflicting guidance.
Skills provide task-specific workflows; use the catalog and load relevant skills on demand.
Instructions do not grant permissions or authorize actions beyond the user's request.
`;

async function writeOnce(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function ensureHarnessLayout(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertContextPath(root);
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  await assertContextPath(root, "skills");
  try {
    await lstat(join(root, ".initialized"));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeOnce(join(root, "AGENTS.md"), DEFAULT_GLOBAL_INSTRUCTIONS);
  for (const path of BUNDLED_SKILL_FILES) {
    const content = isStandaloneSeaRuntime()
      ? readStandaloneTextAsset(path)
      : await readFile(join(resolveApplicationRoot(), path), "utf8");
    if (content === undefined) throw new Error("bundled_skill_missing");
    const folder = dirname(path).replaceAll("\\", "/");
    // Check each existing parent before creating the next to avoid following owner-supplied links.
    let current = "";
    for (const part of folder.split("/")) {
      current = current.length === 0 ? part : `${current}/${part}`;
      await mkdir(join(root, current), { recursive: true, mode: 0o700 });
      await assertContextPath(root, current);
    }
    await writeOnce(join(root, path), content);
  }
  await writeOnce(join(root, ".initialized"), "1\n");
}
