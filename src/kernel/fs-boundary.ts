/**
 * Filesystem Boundary — canonical containment and non-overridable secret-path denial.
 * Wing: kernel | Topic: filesystem-boundary | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3, SECURITY invariants 2-3, and THREAT_MODEL §4.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DENIED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh"
]);

const DENIED_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
]);

export type BoundaryErrorCode = "no_root" | "invalid_path" | "not_found" | "permission_denied";

export class BoundaryError extends Error {
  readonly code: BoundaryErrorCode;

  constructor(code: BoundaryErrorCode, message: string) {
    super(message);
    this.name = "BoundaryError";
    this.code = code;
  }
}

export interface ResolvedBoundaryPath {
  readonly rootReal: string;
  readonly targetReal: string;
  readonly relativePath: string;
}

export interface ResolvedWritableBoundaryPath {
  readonly rootReal: string;
  readonly parentReal: string;
  readonly targetPath: string;
  readonly relativePath: string;
  readonly exists: boolean;
}

function pathSegments(value: string): readonly string[] {
  return value.split(/[\\/]+/u).filter((segment) => segment.length > 0);
}

function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DENIED_DIRECTORY_NAMES.has(lower) ||
    DENIED_FILE_NAMES.has(lower) ||
    lower === ".env" ||
    lower.startsWith(".env.")
  );
}

export function assertNonSecretPath(path: string): void {
  if (pathSegments(path).some(isDeniedName)) {
    throw new BoundaryError("permission_denied", "Path is protected by the secret deny policy");
  }
}

export function isContainedPath(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal + sep);
}

export function assertRelativePath(relPath: string): void {
  if (
    typeof relPath !== "string" ||
    relPath.length === 0 ||
    relPath.includes("\0") ||
    isAbsolute(relPath) ||
    /^[A-Za-z]:/u.test(relPath) ||
    relPath.startsWith("\\\\")
  ) {
    throw new BoundaryError("invalid_path", "A non-empty relative path is required");
  }
  assertNonSecretPath(relPath);
}

/** Resolve and validate a configured workspace root. */
export async function resolveBoundaryRoot(root: string | undefined): Promise<string> {
  if (root === undefined || root.length === 0) {
    throw new BoundaryError("no_root", "No filesystem root is configured");
  }

  let rootReal: string;
  try {
    rootReal = await realpath(root);
    const info = await stat(rootReal);
    if (!info.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new BoundaryError("no_root", "Configured filesystem root does not exist");
  }

  assertNonSecretPath(rootReal);
  return rootReal;
}

/** Resolve one existing relative path and enforce lexical, canonical, and secret boundaries. */
export async function resolveExistingBoundaryPath(
  root: string | undefined,
  relPath: string
): Promise<ResolvedBoundaryPath> {
  assertRelativePath(relPath);
  const rootReal = await resolveBoundaryRoot(root);

  const targetLexical = resolve(rootReal, relPath);
  if (!isContainedPath(rootReal, targetLexical)) {
    throw new BoundaryError("permission_denied", "Path escapes the configured root");
  }

  let targetReal: string;
  try {
    targetReal = await realpath(targetLexical);
  } catch {
    throw new BoundaryError("not_found", "Path does not exist");
  }
  if (!isContainedPath(rootReal, targetReal)) {
    throw new BoundaryError("permission_denied", "Path escapes the configured root");
  }

  const canonicalRelative = relative(rootReal, targetReal);
  assertNonSecretPath(canonicalRelative);

  return {
    rootReal,
    targetReal,
    relativePath: canonicalRelative.split(sep).join("/")
  };
}

/** Resolve a writable target whose parent exists; never follows a final symlink. */
export async function resolveWritableBoundaryPath(
  root: string | undefined,
  relPath: string
): Promise<ResolvedWritableBoundaryPath> {
  assertRelativePath(relPath);
  const rootReal = await resolveBoundaryRoot(root);
  const targetLexical = resolve(rootReal, relPath);
  if (!isContainedPath(rootReal, targetLexical)) {
    throw new BoundaryError("permission_denied", "Path escapes the configured root");
  }

  let parentReal: string;
  try {
    parentReal = await realpath(dirname(targetLexical));
  } catch {
    throw new BoundaryError("not_found", "Parent directory does not exist");
  }
  if (!isContainedPath(rootReal, parentReal)) {
    throw new BoundaryError("permission_denied", "Path escapes the configured root");
  }

  const targetPath = resolve(parentReal, basename(targetLexical));
  if (!isContainedPath(rootReal, targetPath)) {
    throw new BoundaryError("permission_denied", "Path escapes the configured root");
  }
  const canonicalRelative = relative(rootReal, targetPath);
  assertNonSecretPath(canonicalRelative);

  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) {
      throw new BoundaryError("permission_denied", "Symbolic-link write targets are denied");
    }
    const targetReal = await realpath(targetPath);
    if (!isContainedPath(rootReal, targetReal)) {
      throw new BoundaryError("permission_denied", "Path escapes the configured root");
    }
    assertNonSecretPath(relative(rootReal, targetReal));
    return {
      rootReal,
      parentReal,
      targetPath: targetReal,
      relativePath: relative(rootReal, targetReal).split(sep).join("/"),
      exists: true
    };
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BoundaryError("permission_denied", "Write target could not be inspected safely");
    }
  }

  return {
    rootReal,
    parentReal,
    targetPath,
    relativePath: canonicalRelative.split(sep).join("/"),
    exists: false
  };
}
