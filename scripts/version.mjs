/**
 * Version Module — single source of truth for the product release version/line.
 * Wing: ops | Topic: release-version | Updated: 2026-09-04
 *
 * Every consumer (release gate, SEA build, docs-contract gate) derives the current
 * release version and line from `package.json` through this module, so a version
 * change stays consistent everywhere. Do not hardcode a version literal elsewhere.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Supported release shape: X.Y.Z or a numbered release candidate X.Y.Z-rc.N. */
const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-rc\.[1-9][0-9]*)?$/u;

/**
 * @typedef {Object} ReleaseVersion
 * @property {string} version - The full package.json version.
 * @property {number} major - Major component.
 * @property {number} minor - Minor component.
 * @property {number} patch - Patch component.
 * @property {string} releaseLine - The active release line as "major.minor".
 * @property {RegExp} releaseLineRegex - Matches a supported version on the current line.
 */

/**
 * Read and validate the product version from package.json.
 * @returns {Promise<ReleaseVersion>}
 * @throws if the version is missing or not a supported release shape.
 */
export async function readVersion() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const match = VERSION_PATTERN.exec(version ?? "");
  if (!match) {
    throw new Error(
      "version_invalid: package.json version must be X.Y.Z or X.Y.Z-rc.N (non-zero RC number)"
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const releaseLine = `${major}.${minor}`;
  const releaseLineRegex = new RegExp(
    `^${major}\\.${minor}\\.(?:0|[1-9][0-9]*)(?:-rc\\.[1-9][0-9]*)?$`
  );
  return Object.freeze({ version, major, minor, patch, releaseLine, releaseLineRegex });
}

/** Match a `X.Y.x` release-line marker in documentation text. */
export const RELEASE_LINE_MARKER = /\b([0-9]+)\.([0-9]+)\.x\b/gu;
