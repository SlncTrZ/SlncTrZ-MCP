/** Verify one native public release identity across source and emitted target assets. */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readVersion } from "./version.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const nativeTarget =
  process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "win32" && process.arch === "x64"
      ? "win32-x64"
      : undefined;
const requestedTarget = process.argv[3] ?? nativeTarget;
if (requestedTarget === undefined) {
  throw new Error(
    `release_gate_failed: unsupported native target ${process.platform}-${process.arch}`
  );
}
const fileName = requestedTarget === "win32-x64" ? "slnctrz-mcp.exe" : "slnctrz-mcp";
const artifactDir = resolve(process.argv[2] ?? join(root, "dist", "standalone", requestedTarget));
const tag =
  process.env.SLNCTRZ_RELEASE_TAG?.trim() ||
  (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME?.trim() || "" : "");
const expectedCommit =
  process.env.SLNCTRZ_BUILD_COMMIT?.trim() || process.env.GITHUB_SHA?.trim() || "";

function fail(message) {
  throw new Error(`release_gate_failed: ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const { version } = await readVersion();
const expectedTag = `v${version}`;
if (tag.length > 0 && tag !== expectedTag) fail(`tag ${tag} != ${expectedTag}`);

let manifest;
try {
  manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
} catch {
  fail("manifest.json is not valid JSON");
}
if (manifest.schemaVersion !== 1 || manifest.version !== version) {
  fail("manifest version does not match package version");
}
const artifact = manifest.artifacts?.find?.((entry) => entry.target === requestedTarget);
if (!artifact) fail(`manifest ${requestedTarget} artifact missing`);

const binaryPath = join(artifactDir, fileName);
const binary = await readFile(binaryPath);
const binaryStat = await stat(binaryPath);
const sha256 = createHash("sha256").update(binary).digest("hex");
if (artifact.sha256 !== sha256 || artifact.sizeBytes !== binaryStat.size) {
  fail("manifest hash/size does not match emitted binary");
}
if (artifact.fileName !== fileName) {
  fail(`manifest fileName is not canonical ${fileName}`);
}

const sums = await readFile(join(artifactDir, "SHA256SUMS"), "utf8");
const expectedSum = `${sha256}  ${fileName}`;
if (!sums.split(/\r?\n/u).includes(expectedSum)) {
  fail("SHA256SUMS does not match emitted binary");
}

if (requestedTarget !== nativeTarget) {
  fail(`target ${requestedTarget} identity execution must run on its native runner`);
}

const binaryVersion = run(binaryPath, ["--version"]);
if (binaryVersion !== version) {
  fail(`binary version ${binaryVersion} != package ${version}`);
}

let buildInfo;
try {
  buildInfo = JSON.parse(run(binaryPath, ["--build-info"]));
} catch {
  fail("binary --build-info is invalid JSON");
}
if (buildInfo.version !== version) fail("binary build-info version mismatch");
if (typeof buildInfo.buildCommit !== "string" || buildInfo.buildCommit.length === 0) {
  fail("binary build commit missing");
}
if (buildInfo.buildCommit === "unknown") fail("official release binary build commit is unknown");
if (expectedCommit.length > 0 && buildInfo.buildCommit !== expectedCommit) {
  fail(`binary build commit ${buildInfo.buildCommit} != expected ${expectedCommit}`);
}

let url;
try {
  url = new URL(artifact.url);
} catch {
  fail("manifest artifact URL is invalid");
}
if (url.protocol !== "https:") fail("manifest artifact URL must be HTTPS");
if (tag.length > 0 && !url.pathname.includes(`/releases/download/${tag}/`)) {
  fail("manifest artifact URL does not point at the release tag");
}

console.log(
  JSON.stringify({
    status: "pass",
    tag: tag || expectedTag,
    version: version,
    buildCommit: buildInfo.buildCommit,
    target: requestedTarget,
    sha256,
    sizeBytes: binaryStat.size,
    artifactUrl: artifact.url
  })
);
