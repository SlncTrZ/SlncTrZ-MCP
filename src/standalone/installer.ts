/**
 * Standalone Installer — verified versioned artifact activation and rollback.
 * Wing: distribution | Topic: standalone-install | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  selectReleaseArtifact,
  type ReleaseManifest,
  type ReleaseTarget
} from "./release-manifest.js";

const CURRENT_FILE = "current.json";
const VERSION_METADATA = "release.json";

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
  if (installRoot.length === 0 || basename(installRoot) === "..") {
    throw new Error("Standalone installRoot is invalid");
  }
}

function parseInstalledRelease(value: unknown): InstalledRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installed release metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.version !== "string" ||
    typeof record.target !== "string" ||
    typeof record.fileName !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes)
  ) {
    throw new Error("Installed release metadata is invalid");
  }
  return {
    version: record.version,
    target: record.target as ReleaseTarget,
    fileName: record.fileName,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes
  };
}

async function writeActivation(installRoot: string, record: ActivationRecord): Promise<void> {
  const temporary = join(installRoot, `.${CURRENT_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await rename(temporary, join(installRoot, CURRENT_FILE));
}

async function readActivation(installRoot: string): Promise<ActivationRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(installRoot, CURRENT_FILE), "utf8")) as unknown;
    const release = parseInstalledRelease(parsed);
    const previous = (parsed as Record<string, unknown>).previousVersion;
    const previousVersion = typeof previous === "string" ? previous : undefined;
    return { ...release, ...(previousVersion === undefined ? {} : { previousVersion }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  if (!response.ok || response.body === null)
    throw new Error("Standalone artifact download failed");
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
  if (bytes !== expectedSize) throw new Error("Standalone artifact size does not match manifest");
  if (hash.digest("hex") !== expectedSha256)
    throw new Error("Standalone artifact SHA-256 does not match manifest");
}

export async function installStandaloneRelease(
  options: InstallStandaloneReleaseOptions
): Promise<ActivationRecord> {
  validateInstallRoot(options.installRoot);
  const artifact = selectReleaseArtifact(options.manifest, options.target);
  const fetchImpl = options.fetch ?? fetch;
  const versionsRoot = join(options.installRoot, "versions");
  const stagingRoot = join(options.installRoot, ".staging");
  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stage = join(stagingRoot, randomUUID());
  const installed: InstalledRelease = {
    version: options.manifest.version,
    target: artifact.target,
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  };
  try {
    await mkdir(stage, { mode: 0o700 });
    await downloadVerified(
      artifact.url,
      artifact.sha256,
      artifact.sizeBytes,
      join(stage, artifact.fileName),
      fetchImpl,
      options.signal
    );
    await writeFile(join(stage, VERSION_METADATA), `${JSON.stringify(installed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    const destination = versionPath(options.installRoot, installed.version);
    try {
      await rename(stage, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = parseInstalledRelease(
        JSON.parse(await readFile(join(destination, VERSION_METADATA), "utf8"))
      );
      if (existing.sha256 !== installed.sha256 || existing.target !== installed.target) {
        throw new Error("Standalone version already exists with a different artifact");
      }
    }
    const current = await readActivation(options.installRoot);
    const activated: ActivationRecord = {
      ...installed,
      ...(current === undefined ? {} : { previousVersion: current.version })
    };
    await writeActivation(options.installRoot, activated);
    return activated;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function rollbackStandaloneRelease(options: {
  readonly installRoot: string;
}): Promise<ActivationRecord> {
  validateInstallRoot(options.installRoot);
  const current = await readActivation(options.installRoot);
  if (current?.previousVersion === undefined) throw new Error("Standalone rollback is unavailable");
  const previous = parseInstalledRelease(
    JSON.parse(
      await readFile(
        join(versionPath(options.installRoot, current.previousVersion), VERSION_METADATA),
        "utf8"
      )
    )
  );
  const activated: ActivationRecord = { ...previous };
  await writeActivation(options.installRoot, activated);
  return activated;
}
