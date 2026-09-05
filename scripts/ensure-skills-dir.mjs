/** Ensure the repo's skills/ directory exists (cross-platform, harmless if present). */
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = resolve(root, "skills");
mkdirSync(skillsDir, { recursive: true });
process.stdout.write(`[ensure-skills-dir] skills/ ready at ${skillsDir}\n`);
