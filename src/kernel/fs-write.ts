/**
 * Atomic Filesystem Write — dry-run-first UTF-8 writes with optimistic concurrency.
 * Wing: kernel | Topic: fs-write-tool | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3 and THREAT_MODEL mutation gate.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { BoundaryError, resolveWritableBoundaryPath } from "./fs-boundary.js";
import { createExecutionGuard, ExecutionError, type KernelExecutionOptions } from "./execution.js";
import { readContainedFile, ReadError, type ReadResult } from "./fs-read.js";

export const DEFAULT_MAX_WRITE_BYTES = 1_048_576;
const NEW_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const activeWriteTargets = new Set<string>();

export type WriteErrorCode =
  | "no_root"
  | "invalid_path"
  | "not_found"
  | "permission_denied"
  | "too_large"
  | "invalid_encoding"
  | "invalid_limit"
  | "expected_hash_required"
  | "conflict"
  | "not_file";

export class WriteError extends Error {
  readonly code: WriteErrorCode;

  constructor(code: WriteErrorCode, message: string) {
    super(message);
    this.name = "WriteError";
    this.code = code;
  }
}

export interface WriteOptions extends KernelExecutionOptions {
  readonly dryRun?: boolean;
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
}

export interface WriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly previousSha256?: string;
  readonly created: boolean;
  readonly applied: boolean;
}

function mapBoundaryError(error: BoundaryError): WriteError {
  return new WriteError(error.code, error.message);
}

function mapReadError(error: ReadError): WriteError {
  if (error.code === "not_found") return new WriteError("not_file", "Write target is not a file");
  return new WriteError(error.code, error.message);
}

function contentBytes(content: string, maxBytes: number): Buffer {
  if (typeof content !== "string") {
    throw new WriteError("invalid_encoding", "Content must be a UTF-8 string");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maxBytes) {
    throw new WriteError("too_large", `Content exceeds the ${maxBytes}-byte write limit`);
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function acquireWriteTarget(targetPath: string): () => void {
  if (activeWriteTargets.has(targetPath)) {
    throw new WriteError("conflict", "Another write is already in progress");
  }
  activeWriteTargets.add(targetPath);
  return () => activeWriteTargets.delete(targetPath);
}

/** Apply an atomic write, defaulting to a non-mutating preview. */
export async function writeContainedFile(
  root: string | undefined,
  relPath: string,
  content: string,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_WRITE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new WriteError("invalid_limit", "maxBytes must be a positive safe integer");
  }
  if (options.expectedSha256 !== undefined && !SHA256_PATTERN.test(options.expectedSha256)) {
    throw new WriteError("invalid_path", "expectedSha256 must be a SHA-256 hex digest");
  }

  const guard = createExecutionGuard(options);
  guard.checkpoint();
  const bytes = contentBytes(content, maxBytes);
  const nextSha256 = sha256(bytes);

  let boundary;
  try {
    boundary = await resolveWritableBoundaryPath(root, relPath);
  } catch (error) {
    if (error instanceof BoundaryError) throw mapBoundaryError(error);
    throw error;
  }
  guard.checkpoint();

  let previousSha256: string | undefined;
  let existingMode = NEW_FILE_MODE;
  if (boundary.exists) {
    let current: ReadResult;
    try {
      current = await readContainedFile(root, relPath, maxBytes, options);
    } catch (error) {
      if (error instanceof ReadError) throw mapReadError(error);
      throw error;
    }
    previousSha256 = current.sha256;
    const info = await lstat(boundary.targetPath);
    if (!info.isFile()) throw new WriteError("not_file", "Write target is not a regular file");
    existingMode = info.mode & 0o777;

    if (options.dryRun !== false) {
      return {
        path: boundary.relativePath,
        bytes: bytes.length,
        sha256: nextSha256,
        previousSha256,
        created: false,
        applied: false
      };
    }
    if (options.expectedSha256 === undefined) {
      throw new WriteError(
        "expected_hash_required",
        "expectedSha256 is required to overwrite an existing file"
      );
    }
    if (options.expectedSha256.toLowerCase() !== previousSha256) {
      throw new WriteError("conflict", "Existing file no longer matches expectedSha256");
    }
  } else if (options.dryRun !== false) {
    return {
      path: boundary.relativePath,
      bytes: bytes.length,
      sha256: nextSha256,
      created: true,
      applied: false
    };
  }

  guard.checkpoint();
  const targetName = basename(boundary.targetPath);
  const temporaryPath = join(
    boundary.parentReal,
    `.${targetName}.slnctrz-write-${randomUUID()}.tmp`
  );
  let temporaryCreated = false;
  const releaseWriteTarget = acquireWriteTarget(boundary.targetPath);

  try {
    const handle = await open(temporaryPath, "wx", existingMode);
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    guard.checkpoint();

    if (boundary.exists) {
      let current: ReadResult;
      try {
        current = await readContainedFile(root, relPath, maxBytes, options);
      } catch (error) {
        if (error instanceof ReadError) throw mapReadError(error);
        throw error;
      }
      if (current.sha256 !== options.expectedSha256?.toLowerCase()) {
        throw new WriteError("conflict", "Existing file changed before atomic replacement");
      }
      await rename(temporaryPath, boundary.targetPath);
      temporaryCreated = false;
    } else {
      try {
        await link(temporaryPath, boundary.targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new WriteError("conflict", "Write target appeared before atomic creation");
        }
        throw error;
      }
      await rm(temporaryPath);
      temporaryCreated = false;
    }

    return {
      path: boundary.relativePath,
      bytes: bytes.length,
      sha256: nextSha256,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
      created: !boundary.exists,
      applied: true
    };
  } catch (error) {
    if (error instanceof WriteError || error instanceof ExecutionError) throw error;
    throw new WriteError("permission_denied", "Atomic write could not be completed");
  } finally {
    try {
      if (temporaryCreated) await rm(temporaryPath, { force: true });
    } finally {
      releaseWriteTarget();
    }
  }
}
