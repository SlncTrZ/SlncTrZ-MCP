/**
 * Linux x64 SEA Build — bundle, inject, checksum, and emit a release manifest.
 * Wing: distribution | Topic: standalone-sea | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "dist", "standalone", "linux-x64");
const bundleFile = join(outputDirectory, "entry.cjs");
const blobFile = join(outputDirectory, "sea-prep.blob");
const configFile = join(outputDirectory, "sea-config.json");
const binaryFile = join(outputDirectory, "slnctrz-mcp");
const manifestFile = join(outputDirectory, "manifest.json");
const checksumsFile = join(outputDirectory, "SHA256SUMS");
const postject = join(root, "node_modules", ".bin", "postject");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function baseUrl() {
  const value = process.env.SLNCTRZ_RELEASE_BASE_URL;
  if (value === undefined) {
    throw new Error("SLNCTRZ_RELEASE_BASE_URL must name the HTTPS directory for this artifact");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error("SLNCTRZ_RELEASE_BASE_URL must be an HTTPS URL without userinfo");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]);
await build({
  entryPoints: [join(root, "src", "app", "entry.ts")],
  outfile: bundleFile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  legalComments: "none"
});
await writeFile(
  configFile,
  `${JSON.stringify({
    main: bundleFile,
    mainFormat: "commonjs",
    output: blobFile,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none"
  })}\n`,
  "utf8"
);
run(process.execPath, ["--experimental-sea-config", configFile]);
await copyFile(process.execPath, binaryFile);
run(postject, [binaryFile, "NODE_SEA_BLOB", blobFile, "--sentinel-fuse", fuse]);
await chmod(binaryFile, 0o755);
const binary = await readFile(binaryFile);
const sha256 = createHash("sha256").update(binary).digest("hex");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
if (typeof version !== "string") throw new Error("package.json version is invalid");
const url = new URL("slnctrz-mcp", baseUrl()).href;
const manifest = {
  schemaVersion: 1,
  version,
  artifacts: [
    {
      target: "linux-x64",
      url,
      sha256,
      sizeBytes: binary.byteLength,
      fileName: "slnctrz-mcp"
    }
  ]
};
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(checksumsFile, `${sha256}  slnctrz-mcp\n`, "utf8");
console.log(binaryFile);
