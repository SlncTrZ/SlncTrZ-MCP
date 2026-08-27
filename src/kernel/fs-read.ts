/**
 * Contained Filesystem Read — securely read a strict UTF-8 file within a configured root.
 * Wing: kernel | Topic: fs-read-tool | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3 and THREAT_MODEL read-only gate. Reads use the shared
 * filesystem boundary, validate the opened handle, enforce a hard byte limit, and
 * reject invalid UTF-8 rather than silently replacing bytes.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { BoundaryError, isContainedPath, resolveExistingBoundaryPath } from "./fs-boundary.js";
import { createExecutionGuard, type KernelExecutionOptions } from "./execution.js";

export const DEFAULT_MAX_READ_BYTES = 1_048_576;

export class ReadError extends Error {
  readonly code: ReadErrorCode;

  constructor(code: ReadErrorCode, message: string) {
    super(message);
    this.name = "ReadError";
    this.code = code;
  }
}

export type ReadErrorCode =
  | "no_root"
  | "invalid_path"
  | "not_found"
  | "permission_denied"
  | "too_large"
  | "invalid_encoding"
  | "invalid_limit";

export interface ReadResult {
  readonly content: string;
  readonly bytes: number;
  readonly encoding: "utf-8";
  readonly sha256: string;
  readonly hadBom: boolean;
}

function mapBoundaryError(error: BoundaryError): ReadError {
  return new ReadError(error.code, error.message);
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read one strict UTF-8 file through a validated, bounded file handle. */
export async function readContainedFile(
  root: string | undefined,
  relPath: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
  execution: KernelExecutionOptions = {}
): Promise<ReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ReadError("invalid_limit", "maxBytes must be a positive safe integer");
  }

  const guard = createExecutionGuard(execution);
  guard.checkpoint();

  let boundary;
  try {
    boundary = await resolveExistingBoundaryPath(root, relPath);
  } catch (error) {
    if (error instanceof BoundaryError) throw mapBoundaryError(error);
    throw error;
  }

  guard.checkpoint();

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(boundary.targetReal, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ReadError("not_found", "Path does not exist");
    throw new ReadError("permission_denied", "File could not be opened safely");
  }

  try {
    const [openedInfo, currentInfo, currentReal] = await Promise.all([
      handle.stat(),
      lstat(boundary.targetReal),
      realpath(boundary.targetReal)
    ]);
    guard.checkpoint();

    if (
      currentInfo.isSymbolicLink() ||
      !sameFile(openedInfo, currentInfo) ||
      !isContainedPath(boundary.rootReal, currentReal)
    ) {
      throw new ReadError("permission_denied", "File changed during boundary validation");
    }
    if (!openedInfo.isFile()) {
      throw new ReadError("not_found", "Path is not a regular file");
    }
    if (openedInfo.size > maxBytes) {
      throw new ReadError("too_large", `File exceeds the ${maxBytes}-byte read limit`);
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      guard.checkpoint();
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > maxBytes) {
      throw new ReadError("too_large", `File exceeds the ${maxBytes}-byte read limit`);
    }

    const hadBom = total >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    } catch {
      throw new ReadError("invalid_encoding", "File is not valid UTF-8");
    }

    return {
      content,
      bytes: total,
      encoding: "utf-8",
      sha256: createHash("sha256").update(bytes.subarray(0, total)).digest("hex"),
      hadBom
    };
  } finally {
    await handle.close();
  }
}
