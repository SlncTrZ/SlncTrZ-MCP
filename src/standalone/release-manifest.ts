/**
 * Standalone Release Manifest — strict artifact identities for offline-safe installation.
 * Wing: distribution | Topic: standalone-release | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

export type ReleaseTarget =
  "linux-x64" | "linux-arm64" | "win32-x64" | "darwin-x64" | "darwin-arm64";

export interface ReleaseArtifact {
  readonly target: ReleaseTarget;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly artifacts: readonly ReleaseArtifact[];
}

const TARGETS = new Set<ReleaseTarget>([
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

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseArtifact(value: unknown): ReleaseArtifact {
  const raw = record(value, "Release artifact");
  exactKeys(raw, ["target", "url", "sha256", "sizeBytes", "fileName"], "Release artifact");
  const target = requiredString(raw.target, "Release artifact target");
  if (!TARGETS.has(target as ReleaseTarget))
    throw new Error("Release artifact target is unsupported");
  const url = requiredString(raw.url, "Release artifact URL");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Release artifact URL is invalid");
  }
  if (parsedUrl.protocol !== "https:") throw new Error("Release artifact URL must use HTTPS");
  if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    throw new Error("Release artifact URL must not include userinfo");
  }
  const sha256 = requiredString(raw.sha256, "Release artifact SHA-256");
  if (!SHA256.test(sha256)) throw new Error("Release artifact SHA-256 must be lowercase hex");
  const sizeBytes = raw.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error("Release artifact sizeBytes must be a positive safe integer");
  }
  const fileName = requiredString(raw.fileName, "Release artifact fileName");
  if (!FILE_NAME.test(fileName) || fileName === "." || fileName === "..") {
    throw new Error("Release artifact fileName is unsafe");
  }
  return Object.freeze({ target: target as ReleaseTarget, url, sha256, sizeBytes, fileName });
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const raw = record(value, "Release manifest");
  exactKeys(raw, ["schemaVersion", "version", "artifacts"], "Release manifest");
  if (raw.schemaVersion !== 1) throw new Error("Release manifest schemaVersion must be 1");
  const version = requiredString(raw.version, "Release manifest version");
  if (!SEMVER.test(version))
    throw new Error("Release manifest version must be semantic versioning");
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0) {
    throw new Error("Release manifest artifacts must be a non-empty array");
  }
  const targets = new Set<string>();
  const artifacts = raw.artifacts.map((artifact) => {
    const parsed = parseArtifact(artifact);
    if (targets.has(parsed.target)) throw new Error("Release manifest has duplicate target");
    targets.add(parsed.target);
    return parsed;
  });
  return Object.freeze({ schemaVersion: 1, version, artifacts: Object.freeze(artifacts) });
}

export function selectReleaseArtifact(
  manifest: ReleaseManifest,
  target: ReleaseTarget
): ReleaseArtifact {
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
  if (artifact === undefined) throw new Error(`Release manifest does not contain target ${target}`);
  return artifact;
}

export function currentReleaseTarget(
  platform = process.platform,
  architecture = process.arch
): ReleaseTarget {
  const target = `${platform}-${architecture}`;
  if (!TARGETS.has(target as ReleaseTarget))
    throw new Error(`Standalone target is unsupported: ${target}`);
  return target as ReleaseTarget;
}
