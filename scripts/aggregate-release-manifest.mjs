/** Aggregate verified native target artifacts into one canonical release directory. */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const outputDirectory = resolve(process.argv[2] ?? "");
const inputDirectories = process.argv.slice(3).map((value) => resolve(value));
if (process.argv[2] === undefined || inputDirectories.length < 1) {
  throw new Error(
    "Usage: node scripts/aggregate-release-manifest.mjs <output-dir> <target-dir>..."
  );
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

let version;
const artifacts = [];
const targets = new Set();
for (const directory of inputDirectories) {
  const fragment = JSON.parse(
    await readFile(join(directory, "manifest-fragment.json"), "utf8")
  );
  if (
    fragment.schemaVersion !== 1 ||
    typeof fragment.version !== "string" ||
    typeof fragment.artifact !== "object" ||
    fragment.artifact === null
  ) {
    throw new Error(`Invalid manifest fragment: ${directory}`);
  }
  if (version === undefined) version = fragment.version;
  if (fragment.version !== version) throw new Error("Target manifest versions differ");

  const artifact = fragment.artifact;
  if (
    typeof artifact.target !== "string" ||
    typeof artifact.fileName !== "string" ||
    typeof artifact.sha256 !== "string" ||
    typeof artifact.sizeBytes !== "number" ||
    typeof artifact.url !== "string"
  ) {
    throw new Error(`Invalid target artifact fragment: ${directory}`);
  }
  if (targets.has(artifact.target)) throw new Error(`Duplicate target: ${artifact.target}`);
  targets.add(artifact.target);

  const source = join(directory, artifact.fileName);
  const bytes = await readFile(source);
  const size = (await stat(source)).size;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (size !== artifact.sizeBytes || sha256 !== artifact.sha256) {
    throw new Error(`Target artifact does not match fragment: ${artifact.target}`);
  }
  if (basename(source) !== artifact.fileName) throw new Error("Unsafe artifact fileName");
  await copyFile(source, join(outputDirectory, artifact.fileName));
  artifacts.push(artifact);
}

artifacts.sort((left, right) => left.target.localeCompare(right.target));
const manifest = { schemaVersion: 1, version, artifacts };
await writeFile(
  join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
await writeFile(
  join(outputDirectory, "SHA256SUMS"),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}`).join("\n")}\n`,
  "utf8"
);
console.log(
  JSON.stringify({
    status: "pass",
    version,
    targets: artifacts.map((artifact) => artifact.target)
  })
);
