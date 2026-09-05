/** Generate a deterministic dependency/license inventory from package-lock.json. */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const outIndex = process.argv.indexOf("--out");
const outputPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (outIndex >= 0 && !outputPath) throw new Error("--out requires a path");

const packages = Object.entries(lock.packages ?? {})
  .filter(
    ([path, record]) => path.startsWith("node_modules/") && record && typeof record === "object"
  )
  .map(([path, record]) => {
    const name = path.slice("node_modules/".length);
    return {
      name,
      version: typeof record.version === "string" ? record.version : "unknown",
      license: typeof record.license === "string" ? record.license : "UNKNOWN",
      dev: record.dev === true,
      optional: record.optional === true
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const inventory = {
  schemaVersion: 1,
  package: lock.name,
  version: lock.version,
  generatedFrom: "package-lock.json",
  dependencies: packages
};
const body = `${JSON.stringify(inventory, null, 2)}\n`;
if (outputPath) await writeFile(resolve(outputPath), body, "utf8");
else process.stdout.write(body);
