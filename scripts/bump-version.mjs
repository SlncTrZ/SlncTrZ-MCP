/**
 * Bump Version — single entry point for a product version change.
 * Wing: ops | Topic: release-version | Updated: 2026-09-04
 *
 * Updates every version-bearing artifact in one command so nothing drifts:
 *   node scripts/bump-version.mjs <X.Y.Z[-rc.N]>
 *   (or: npm run bump -- 0.1.2)
 *
 * Touches package.json, package-lock.json and the current-release-line references
 * in RELEASE.md / README.md / PROVENANCE.md. The docs-contract drift gate
 * (scripts/docs-check.mjs) re-verifies consistency after the change.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const requested = process.argv[2];
const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-rc\.[1-9][0-9]*)?$/u;

if (!VERSION_PATTERN.test(requested ?? "")) {
  throw new Error("usage: node scripts/bump-version.mjs <X.Y.Z[-rc.N]>  (non-zero RC number)");
}
const [major, minor] = requested.split(".").map(Number);
const releaseLine = `${major}.${minor}`;

async function writeJsonPretty(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// 1. package.json
const pkgJsonPath = join(root, "package.json");
const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
pkg.version = requested;
await writeJsonPretty(pkgJsonPath, pkg);

// 2. package-lock.json (root version + packages[""].version)
const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = requested;
if (lock.packages?.[""]) lock.packages[""].version = requested;
await writeJsonPretty(lockPath, lock);

// 3. CHANGELOG.md — insert a fresh release section at the top of the entries
const changelogPath = join(root, "CHANGELOG.md");
const changelog = await readFile(changelogPath, "utf8");
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
const section = `## ${requested}\n\nDate: ${date}\n\n### Added\n\n- \n\n`;
const headerEnd = changelog.indexOf("\n## ");
const nextChangelog = headerEnd === -1
  ? `${changelog}\n\n${section}`
  : `${changelog.slice(0, headerEnd)}\n${section}${changelog.slice(headerEnd + 1)}`;
await writeFile(changelogPath, nextChangelog, "utf8");

// 4. Current-release-line references in the public docs.
// Replace every `X.Y.x` release-line marker with the new line, so nothing drifts.
// The docs-contract drift gate (docs-check.mjs) re-verifies only the current line remains.
const docFiles = ["RELEASE.md", "README.md", "PROVENANCE.md"];
for (const file of docFiles) {
  const filePath = join(root, file);
  let text = await readFile(filePath, "utf8");
  text = text.replace(/\b[0-9]+\.[0-9]+\.x\b/gu, `${releaseLine}.x`);
  await writeFile(filePath, text, "utf8");
}

console.log(`bumped to ${requested} (release line ${releaseLine}.x); verify with: npm run docs:check`);
