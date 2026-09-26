/**
 * Standalone Installer — verified versioned artifact activation and rollback.
 * Wing: distribution | Topic: standalone-install | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  parseReleaseManifest,
  selectReleaseArtifact,
  type ReleaseManifest,
  type ReleaseTarget
} from "./release-manifest.js";
import {
  fetchHttpsWithRedirects,
  isTransientFetchError,
  waitForNetworkRetry
} from "./https-fetch.js";

const CURRENT_FILE = "current.json";
const VERSION_METADATA = "release.json";
const RELEASE_TARGETS = new Set<ReleaseTarget>([
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "darwin-x64",
  "darwin-arm64"
]);
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BUILD_COMMIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const DEFAULT_MAX_STANDALONE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_STANDALONE_ARTIFACT_ATTEMPTS = 4;
export const DEFAULT_STANDALONE_ARTIFACT_RETRY_DELAY_MS = 2_000;
const MAX_STANDALONE_ARTIFACT_RETRY_DELAY_MS = 15_000;

interface InstalledRelease {
  readonly version: string;
  readonly buildCommit?: string;
  readonly target: ReleaseTarget;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ActivationRecord extends InstalledRelease {
  readonly previousVersion?: string;
}

interface InstallerMutations {
  readonly createWriteStream: typeof createWriteStream;
  readonly mkdir: typeof mkdir;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

const NODE_INSTALLER_MUTATIONS: InstallerMutations = {
  createWriteStream,
  mkdir,
  rename,
  rm,
  writeFile
};

export interface InstallStandaloneReleaseOptions {
  readonly installRoot: string;
  readonly manifest: ReleaseManifest;
  readonly target: ReleaseTarget;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly mutations?: Partial<InstallerMutations>;
  readonly maxArtifactBytes?: number;
  readonly artifactAttempts?: number;
  readonly artifactRetryDelayMs?: number;
}

function versionPath(installRoot: string, version: string): string {
  return join(installRoot, "versions", version);
}

function validateInstallRoot(installRoot: string): void {
  const normalized = resolve(installRoot);
  if (
    installRoot.length === 0 ||
    !isAbsolute(installRoot) ||
    normalized === parse(normalized).root ||
    basename(installRoot) === ".."
  ) {
    throw new Error("Standalone installRoot is invalid");
  }
}

async function assertPlainDirectoryOrMissing(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink or other file type`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertPlainFileOrMissing(path: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} must be a real file, not a symlink or other file type`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertSafeInstallLayout(installRoot: string): Promise<void> {
  await assertPlainDirectoryOrMissing(installRoot, "Standalone install root");
  await assertPlainDirectoryOrMissing(
    join(installRoot, "versions"),
    "Standalone versions directory"
  );
  await assertPlainDirectoryOrMissing(
    join(installRoot, ".staging"),
    "Standalone staging directory"
  );
}

function parseInstalledRelease(value: unknown, allowPreviousVersion = false): ActivationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installed release metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "version",
    "buildCommit",
    "target",
    "fileName",
    "sha256",
    "sizeBytes",
    ...(allowPreviousVersion ? ["previousVersion"] : [])
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error("Installed release metadata is invalid");
  }
  if (
    typeof record.version !== "string" ||
    !SEMVER.test(record.version) ||
    (record.buildCommit !== undefined &&
      (typeof record.buildCommit !== "string" || !BUILD_COMMIT.test(record.buildCommit))) ||
    typeof record.target !== "string" ||
    !RELEASE_TARGETS.has(record.target as ReleaseTarget) ||
    typeof record.fileName !== "string" ||
    !FILE_NAME.test(record.fileName) ||
    record.fileName === "." ||
    record.fileName === ".." ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256) ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 1
  ) {
    throw new Error("Installed release metadata is invalid");
  }
  const previous = record.previousVersion;
  if (previous !== undefined && (typeof previous !== "string" || !SEMVER.test(previous))) {
    throw new Error("Installed release metadata is invalid");
  }
  return {
    version: record.version,
    ...(record.buildCommit === undefined ? {} : { buildCommit: record.buildCommit as string }),
    target: record.target as ReleaseTarget,
    fileName: record.fileName,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    ...(previous === undefined ? {} : { previousVersion: previous as string })
  };
}

async function writeActivation(
  installRoot: string,
  record: ActivationRecord,
  mutations: InstallerMutations
): Promise<void> {
  const temporary = join(installRoot, `.${CURRENT_FILE}.${randomUUID()}.tmp`);
  await mutations.writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx"
  });
  try {
    await mutations.rename(temporary, join(installRoot, CURRENT_FILE));
  } finally {
    await mutations.rm(temporary, { force: true });
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Installed release metadata is invalid");
    throw error;
  }
}

async function readActivation(installRoot: string): Promise<ActivationRecord | undefined> {
  const path = join(installRoot, CURRENT_FILE);
  if (!(await assertPlainFileOrMissing(path, "Standalone activation metadata"))) return undefined;
  return parseInstalledRelease(await readJson(path), true);
}

export async function readCurrentStandaloneActivation(
  installRoot: string
): Promise<ActivationRecord | undefined> {
  validateInstallRoot(installRoot);
  await assertSafeInstallLayout(installRoot);
  return readActivation(installRoot);
}

export async function restoreStandaloneActivation(
  installRoot: string,
  activation: ActivationRecord
): Promise<void> {
  validateInstallRoot(installRoot);
  await assertSafeInstallLayout(installRoot);
  const installed = await readInstalledVersion(installRoot, activation.version);
  if (installed === undefined || !sameRelease(installed, activation)) {
    throw new Error("Standalone rollback activation is unavailable");
  }
  await writeActivation(installRoot, activation, NODE_INSTALLER_MUTATIONS);
}

async function readInstalledVersion(
  installRoot: string,
  version: string
): Promise<InstalledRelease | undefined> {
  const directory = versionPath(installRoot, version);
  await assertPlainDirectoryOrMissing(directory, "Standalone version directory");
  const metadata = join(directory, VERSION_METADATA);
  if (!(await assertPlainFileOrMissing(metadata, "Standalone release metadata"))) return undefined;
  return parseInstalledRelease(await readJson(metadata));
}

async function verifyInstalledReleaseBytes(
  installRoot: string,
  installed: InstalledRelease
): Promise<{ readonly executable: string; readonly sizeBytes: number; readonly sha256: string }> {
  const versionDirectory = versionPath(installRoot, installed.version);
  await assertPlainDirectoryOrMissing(versionDirectory, "Standalone version directory");
  const executable = join(versionDirectory, installed.fileName);
  const linkInfo = await lstat(executable);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error("Standalone installed artifact is invalid");
  }
  const bytes = await readFile(executable);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== installed.sizeBytes) {
    throw new Error("Standalone installed artifact size does not match release metadata");
  }
  if (actualSha256 !== installed.sha256) {
    throw new Error("Standalone installed artifact SHA-256 does not match release metadata");
  }
  return { executable, sizeBytes: bytes.byteLength, sha256: actualSha256 };
}

function sameRelease(left: InstalledRelease, right: InstalledRelease): boolean {
  return (
    left.version === right.version &&
    left.buildCommit === right.buildCommit &&
    left.target === right.target &&
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

async function activateRelease(
  installRoot: string,
  installed: InstalledRelease,
  mutations: InstallerMutations
): Promise<ActivationRecord> {
  const current = await readActivation(installRoot);
  if (current !== undefined && sameRelease(current, installed)) return current;
  const activated: ActivationRecord = {
    ...installed,
    ...(current === undefined ? {} : { previousVersion: current.version })
  };
  await writeActivation(installRoot, activated, mutations);
  return activated;
}

async function downloadVerified(
  url: string,
  expectedSha256: string,
  expectedSize: number,
  destination: string,
  fetchImpl: typeof fetch,
  mutations: InstallerMutations,
  signal: AbortSignal | undefined,
  attempts: number,
  retryDelayMs: number
): Promise<void> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetchHttpsWithRedirects(url, {
        fetch: fetchImpl,
        ...(signal === undefined ? {} : { signal }),
        label: "Standalone artifact URL"
      });
      break;
    } catch (error) {
      if (!isTransientFetchError(error) || attempt === attempts) throw error;
      await waitForNetworkRetry(
        attempt,
        retryDelayMs,
        MAX_STANDALONE_ARTIFACT_RETRY_DELAY_MS,
        signal
      );
    }
  }
  if (response === undefined || !response.ok || response.body === null) {
    throw new Error("Standalone artifact download failed");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > expectedSize) {
        callback(new Error("Standalone artifact exceeds declared size"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    verifier,
    mutations.createWriteStream(destination, { flags: "wx", mode: 0o755 })
  );
  if (bytes !== expectedSize) {
    throw new Error("Standalone artifact size does not match manifest");
  }
  if (hash.digest("hex") !== expectedSha256) {
    throw new Error("Standalone artifact SHA-256 does not match manifest");
  }
}

export async function installStandaloneRelease(
  options: InstallStandaloneReleaseOptions
): Promise<ActivationRecord> {
  validateInstallRoot(options.installRoot);
  await assertSafeInstallLayout(options.installRoot);
  const mutations: InstallerMutations = { ...NODE_INSTALLER_MUTATIONS, ...options.mutations };
  const manifest = parseReleaseManifest(options.manifest);
  const artifact = selectReleaseArtifact(manifest, options.target);
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_STANDALONE_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
    throw new Error("Standalone artifact size ceiling must be a positive safe integer");
  }
  if (artifact.sizeBytes > maxArtifactBytes) {
    throw new Error("Standalone artifact exceeds product size ceiling");
  }
  const artifactAttempts = options.artifactAttempts ?? DEFAULT_STANDALONE_ARTIFACT_ATTEMPTS;
  const artifactRetryDelayMs =
    options.artifactRetryDelayMs ?? DEFAULT_STANDALONE_ARTIFACT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(artifactAttempts) || artifactAttempts < 1 || artifactAttempts > 10) {
    throw new Error("Standalone artifact attempts must be an integer from 1 to 10");
  }
  if (
    !Number.isSafeInteger(artifactRetryDelayMs) ||
    artifactRetryDelayMs < 0 ||
    artifactRetryDelayMs > 30_000
  ) {
    throw new Error("Standalone artifact retry delay must be an integer from 0 to 30000");
  }
  const installed: InstalledRelease = {
    version: manifest.version,
    ...(manifest.buildCommit === undefined ? {} : { buildCommit: manifest.buildCommit }),
    target: artifact.target,
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  };
  const existing = await readInstalledVersion(options.installRoot, installed.version);
  if (existing !== undefined) {
    if (!sameRelease(existing, installed)) {
      throw new Error("Standalone version already exists with a different artifact");
    }
    return activateRelease(options.installRoot, existing, mutations);
  }

  const versionsRoot = join(options.installRoot, "versions");
  const stagingRoot = join(options.installRoot, ".staging");
  await mutations.mkdir(versionsRoot, { recursive: true, mode: 0o755 });
  await mutations.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stage = join(stagingRoot, randomUUID());
  try {
    await mutations.mkdir(stage, { mode: 0o755 });
    await downloadVerified(
      artifact.url,
      artifact.sha256,
      artifact.sizeBytes,
      join(stage, artifact.fileName),
      options.fetch ?? fetch,
      mutations,
      options.signal,
      artifactAttempts,
      artifactRetryDelayMs
    );
    await mutations.writeFile(join(stage, VERSION_METADATA), `${JSON.stringify(installed)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx"
    });
    try {
      await mutations.rename(stage, versionPath(options.installRoot, installed.version));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const raced = await readInstalledVersion(options.installRoot, installed.version);
      if (raced === undefined || !sameRelease(raced, installed)) {
        throw new Error("Standalone version already exists with a different artifact");
      }
    }
    return activateRelease(options.installRoot, installed, mutations);
  } finally {
    await mutations.rm(stage, { recursive: true, force: true });
  }
}

export async function rollbackStandaloneRelease(options: {
  readonly installRoot: string;
  readonly mutations?: Partial<InstallerMutations>;
}): Promise<ActivationRecord> {
  validateInstallRoot(options.installRoot);
  await assertSafeInstallLayout(options.installRoot);
  const mutations: InstallerMutations = { ...NODE_INSTALLER_MUTATIONS, ...options.mutations };
  const current = await readActivation(options.installRoot);
  if (current?.previousVersion === undefined) {
    throw new Error("Standalone rollback is unavailable");
  }
  const previous = await readInstalledVersion(options.installRoot, current.previousVersion);
  if (previous === undefined) throw new Error("Standalone rollback target is unavailable");
  await verifyInstalledReleaseBytes(options.installRoot, previous);
  const activated: ActivationRecord = { ...previous };
  await writeActivation(options.installRoot, activated, mutations);
  return activated;
}

/** Resolve the active executable through validated activation metadata, never a symlink. */
export async function resolveCurrentStandaloneExecutable(installRoot: string): Promise<string> {
  validateInstallRoot(installRoot);
  await assertSafeInstallLayout(installRoot);
  const current = await readActivation(installRoot);
  if (current === undefined) throw new Error("Standalone activation is unavailable");
  const versionDirectory = versionPath(installRoot, current.version);
  await assertPlainDirectoryOrMissing(versionDirectory, "Standalone active version directory");
  const executable = join(versionDirectory, current.fileName);
  const linkInfo = await lstat(executable);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error("Standalone active executable is invalid");
  }
  return executable;
}

export interface InstalledIntegrityResult {
  readonly activation: ActivationRecord;
  readonly executable: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** Revalidate active installed bytes against immutable activation metadata. */
export async function verifyCurrentStandaloneIntegrity(
  installRoot: string
): Promise<InstalledIntegrityResult> {
  const activation = await readActivation(installRoot);
  if (activation === undefined) throw new Error("Standalone activation is unavailable");
  const verified = await verifyInstalledReleaseBytes(installRoot, activation);
  return {
    activation,
    executable: verified.executable,
    sizeBytes: verified.sizeBytes,
    sha256: verified.sha256
  };
}
