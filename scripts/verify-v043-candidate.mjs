import { execFileSync } from "node:child_process";
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", "repos/SlncTrZ/SlncTrZ-MCP/" + path], { encoding: "utf8" })
  );
const run = api("actions/runs/38019726916");
if (run.head_sha !== "6df67949bb303ae800e2e17ddcbea199bb9a640d" || run.event !== "push")
  throw new Error("Original release identity mismatch");
const jobs = api("actions/runs/38019726916/jobs?per_page=100").jobs;
for (const name of [
  "Node 22 release gate",
  "Node 24 release gate",
  "Windows Node 24 release gate",
  "build Linux x64 SEA",
  "build Windows x64 SEA",
  "verify Linux x64 SEA + identity",
  "verify Windows x64 SEA + identity",
  "aggregate multi-target release",
  "publish prerelease candidate"
]) {
  if (!jobs.some((job) => job.name === name && job.conclusion === "success"))
    throw new Error("Original gate not successful: " + name);
}
const release = api("releases/tags/v0.4.3");
if (release.draft || !release.prerelease)
  throw new Error("Expected published prerelease candidate");
const expected = {
  "install.sh": "sha256:49d16921d8e7c99e9def77d0c1b15664b8756bbb394869adfe54fc2d43a9dbcd",
  "manifest.json": "sha256:a14cd010402fd12ccc3928440eadb28590a68252fc1a24bf053de96476cf51e2",
  "manifest.json.sig": "sha256:8ff163cce366c74b348be303335d0a78e2b3a0784aa2812ee651ce9904fc4f0a",
  SHA256SUMS: "sha256:51544a4cfea29eb2eace2623051d3fc408b644332540015c744f4c89c0cc73b9",
  "slnctrz-mcp": "sha256:502ee009ceadd9c2a0e3e02c43c760acafd7057f82f6c1f0ac1880db07adc667",
  "slnctrz-mcp.exe": "sha256:28037103d9b8c921c62137e2d2278530f97d18a78dd71d662f8d0a0c893343af"
};
if (release.assets.length !== Object.keys(expected).length) throw new Error("Asset set changed");
for (const asset of release.assets) {
  if (expected[asset.name] !== asset.digest || asset.state !== "uploaded")
    throw new Error("Candidate asset changed: " + asset.name);
}
const tagged = execFileSync("git", ["rev-parse", "v0.4.3^{commit}"], { encoding: "utf8" }).trim();
if (tagged !== run.head_sha) throw new Error("Tag moved");
execFileSync("git", ["merge-base", "--is-ancestor", tagged, "origin/main"]);
const changes = execFileSync("git", ["diff", "--name-only", tagged, "HEAD"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/u)
  .filter(Boolean);
const allowed = new Set([
  "scripts/usage-browser-e2e.mjs",
  ".github/workflows/v043-public-acceptance.yml",
  "scripts/verify-v043-candidate.mjs",
  "docs/PROJECT_STATUS.md",
  "RELEASE.md"
]);
if (changes.some((path) => !allowed.has(path)))
  throw new Error("Product/source identity changed after tag");
console.log("v043_unchanged_signed_candidate=pass");
