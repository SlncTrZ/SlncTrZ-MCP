/**
 * Native SEA Build — bundle, inject, checksum, and emit target metadata.
 * Supported public build targets are produced on their native runners.
 */

import { createHash, createPublicKey } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { readVersion } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeTarget =
  process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "win32" && process.arch === "x64"
      ? "win32-x64"
      : undefined;
if (nativeTarget === undefined) {
  throw new Error(`Native SEA build target is unsupported: ${process.platform}-${process.arch}`);
}
const requestedTarget = process.argv[2] ?? nativeTarget;
if (requestedTarget !== nativeTarget) {
  throw new Error(
    `SEA target ${requestedTarget} must be built on its native runner; current target is ${nativeTarget}`
  );
}

const fileName = nativeTarget === "win32-x64" ? "slnctrz-mcp.exe" : "slnctrz-mcp";
const outputDirectory = join(root, "dist", "standalone", nativeTarget);
const bundleFile = join(outputDirectory, "entry.cjs");
const blobFile = join(outputDirectory, "sea-prep.blob");
const configFile = join(outputDirectory, "sea-config.json");
const binaryFile = join(outputDirectory, fileName);
const manifestFile = join(outputDirectory, "manifest.json");
const manifestFragmentFile = join(outputDirectory, "manifest-fragment.json");
const checksumsFile = join(outputDirectory, "SHA256SUMS");
const postjectCli = join(root, "node_modules", "postject", "dist", "cli.js");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const buildCommit =
  process.env.SLNCTRZ_BUILD_COMMIT?.trim() || process.env.GITHUB_SHA?.trim() || "unknown";
const releaseSigningPublicKeyB64 = process.env.SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64?.trim();
if (releaseSigningPublicKeyB64 === undefined || releaseSigningPublicKeyB64.length === 0) {
  throw new Error("SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64 is required for standalone release builds");
}
const releaseSigningPublicKey = Buffer.from(releaseSigningPublicKeyB64, "base64");
if (releaseSigningPublicKey.length === 0 || releaseSigningPublicKey.toString("base64") !== releaseSigningPublicKeyB64) {
  throw new Error("SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64 must be canonical base64 SPKI");
}
const parsedReleaseSigningPublicKey = createPublicKey({
  key: releaseSigningPublicKey,
  format: "der",
  type: "spki"
});
if (parsedReleaseSigningPublicKey.asymmetricKeyType !== "ed25519") {
  throw new Error("Release signing public key must be Ed25519");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
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
  define: {
    "process.env.SLNCTRZ_BUILD_COMMIT": JSON.stringify(buildCommit),
    __SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64__: JSON.stringify(releaseSigningPublicKeyB64)
  },
  legalComments: "none"
});
await writeFile(
  configFile,
  `${JSON.stringify({
    main: bundleFile,
    mainFormat: "commonjs",
    output: blobFile,
    assets: {
      "SlncHertine.woff2": join(root, "src", "assets", "fonts", "SlncHertine.woff2"),
      "config/commands.json": join(root, "config", "commands.json"),
      "config/commands.win32.json": join(root, "config", "commands.win32.json"),
      "config/systemd/slnctrz-mcp.service": join(root, "config", "systemd", "slnctrz-mcp.service"),
      "config/systemd/slnctrz-mcp-launcher.sh": join(
        root,
        "config",
        "systemd",
        "slnctrz-mcp-launcher.sh"
      ),
      "config/systemd/gateway.env.example": join(root, "config", "systemd", "gateway.env.example"),
      "AGENTS.md": join(root, "AGENTS.md"),
      "skills/code-review/SKILL.md": join(root, "skills", "code-review", "SKILL.md"),
      "skills/debug-and-test/SKILL.md": join(root, "skills", "debug-and-test", "SKILL.md"),
      "skills/debug-and-test/references/regression-checks.md": join(
        root,
        "skills",
        "debug-and-test",
        "references",
        "regression-checks.md"
      ),
      "docs/MODEL_GUIDE.md": join(root, "docs", "MODEL_GUIDE.md")
    },
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none"
  })}\n`,
  "utf8"
);
run(process.execPath, ["--experimental-sea-config", configFile]);
await copyFile(process.execPath, binaryFile);
run(process.execPath, [
  postjectCli,
  binaryFile,
  "NODE_SEA_BLOB",
  blobFile,
  "--sentinel-fuse",
  fuse
]);
if (process.platform !== "win32") await chmod(binaryFile, 0o755);

const binary = await readFile(binaryFile);
const sha256 = createHash("sha256").update(binary).digest("hex");
const { version } = await readVersion();
const artifact = {
  target: nativeTarget,
  url: new URL(fileName, baseUrl()).href,
  sha256,
  sizeBytes: binary.byteLength,
  fileName
};
const manifest = {
  schemaVersion: 1,
  version,
  buildCommit,
  artifacts: [artifact]
};
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(
  manifestFragmentFile,
  `${JSON.stringify({ schemaVersion: 1, version, buildCommit, artifact }, null, 2)}\n`,
  "utf8"
);
await writeFile(checksumsFile, `${sha256}  ${fileName}\n`, "utf8");
console.log(binaryFile);
