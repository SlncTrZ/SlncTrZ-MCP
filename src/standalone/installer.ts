/**
 * Standalone Installer — verified versioned artifact activation and rollback.
 * Wing: distribution | Topic: standalone-install | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

interface InstalledRelease {
  readonly version: string;
  readonly target: ReleaseTarget;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ActivationRecord extends InstalledRelease {
  readonly previousVersion?: string;
}

export interface InstallStandaloneReleaseOptions {
  readonly installRoot: string;
  readonly manifest: ReleaseManifest;
  readonly target: ReleaseTarget;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
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

function parseInstalledRelease(value: unknown, allowPreviousVersion = false): ActivationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installed release metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "version",
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
    target: record.target as ReleaseTarget,
    fileName: record.fileName,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    ...(previous === undefined ? {} : { previousVersion: previous as string })
  };
}

async function writeActivation(installRoot: string, record: ActivationRecord): Promise<void> {
  const temporary = join(installRoot, `.${CURRENT_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  try {
    await rename(temporary, join(installRoot, CURRENT_FILE));
  } finally {
    await rm(temporary, { force: true });
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
  try {
    return parseInstalledRelease(await readJson(join(installRoot, CURRENT_FILE)), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readInstalledVersion(
  installRoot: string,
  version: string
): Promise<InstalledRelease | undefined> {
  try {
    return parseInstalledRelease(
      await readJson(join(versionPath(installRoot, version), VERSION_METADATA))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameRelease(left: InstalledRelease, right: InstalledRelease): boolean {
  return (
    left.version === right.version &&
    left.target === right.target &&
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

async function activateRelease(
  installRoot: string,
  installed: InstalledRelease
): Promise<ActivationRecord> {
  const current = await readActivation(installRoot);
  if (current !== undefined && sameRelease(current, installed)) return current;
  const activated: ActivationRecord = {
    ...installed,
    ...(current === undefined ? {} : { previousVersion: current.version })
  };
  await writeActivation(installRoot, activated);
  return activated;
}

async function downloadVerified(
  url: string,
  expectedSha256: string,
  expectedSize: number,
  destination: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetchImpl(url, {
    redirect: "error",
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok || response.body === null) {
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
    createWriteStream(destination, { flags: "wx", mode: 0o700 })
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
  const manifest = parseReleaseManifest(options.manifest);
  const artifact = selectReleaseArtifact(manifest, options.target);
  const installed: InstalledRelease = {
    version: manifest.version,
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
    return activateRelease(options.installRoot, existing);
  }

  const versionsRoot = join(options.installRoot, "versions");
  const stagingRoot = join(options.installRoot, ".staging");
  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stage = join(stagingRoot, randomUUID());
  try {
    await mkdir(stage, { mode: 0o700 });
    await downloadVerified(
      artifact.url,
      artifact.sha256,
      artifact.sizeBytes,
      join(stage, artifact.fileName),
      options.fetch ?? fetch,
      options.signal
    );
    await writeFile(join(stage, VERSION_METADATA), `${JSON.stringify(installed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    try {
      await rename(stage, versionPath(options.installRoot, installed.version));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const raced = await readInstalledVersion(options.installRoot, installed.version);
      if (raced === undefined || !sameRelease(raced, installed)) {
        throw new Error("Standalone version already exists with a different artifact");
      }
    }
    return activateRelease(options.installRoot, installed);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function rollbackStandaloneRelease(options: {
  readonly installRoot: string;
}): Promise<ActivationRecord> {
  validateInstallRoot(options.installRoot);
  const current = await readActivation(options.installRoot);
  if (current?.previousVersion === undefined) {
    throw new Error("Standalone rollback is unavailable");
  }
  const previous = await readInstalledVersion(options.installRoot, current.previousVersion);
  if (previous === undefined) throw new Error("Standalone rollback target is unavailable");
  const activated: ActivationRecord = { ...previous };
  await writeActivation(options.installRoot, activated);
  return activated;
}

/** Resolve the active executable through validated activation metadata, never a symlink. */
export async function resolveCurrentStandaloneExecutable(installRoot: string): Promise<string> {
  validateInstallRoot(installRoot);
  const current = await readActivation(installRoot);
  if (current === undefined) throw new Error("Standalone activation is unavailable");
  const executable = join(versionPath(installRoot, current.version), current.fileName);
  const info = await stat(executable);
  if (!info.isFile()) throw new Error("Standalone active executable is invalid");
  return executable;
}
