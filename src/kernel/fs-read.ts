/**
 * Contained Filesystem Read — securely read a UTF-8 file within a configured root.
 * Wing: kernel | Topic: fs-read-tool | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 3 (symlink-aware containment, explicit size limit) and
 * SECURITY default-deny. Reads are confined to a single configured root; absolute
 * paths and paths that resolve (or symlink) outside the root are rejected.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Bounded read limit — 1 MiB. Explicit named constant, never declared inline. */
export const DEFAULT_MAX_READ_BYTES = 1_048_576;

/** Discriminated failure class for the contained read. */
export class ReadError extends Error {
  readonly code: ReadErrorCode;
  constructor(code: ReadErrorCode, message: string) {
    super(message);
    this.name = "ReadError";
    this.code = code;
  }
}

export type ReadErrorCode =
  "no_root" | "invalid_path" | "not_found" | "permission_denied" | "too_large" | "invalid_limit";

export interface ReadResult {
  readonly content: string;
  readonly bytes: number;
  readonly encoding: "utf-8";
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Read a UTF-8 file, confined to `root`, with a hard byte limit. Default-deny. */
export async function readContainedFile(
  root: string | undefined,
  relPath: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): Promise<ReadResult> {
  if (root === undefined || root.length === 0) {
    throw new ReadError("no_root", "No filesystem root is configured");
  }
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new ReadError("invalid_path", "A non-empty path is required");
  }
  if (isAbsolutePath(relPath)) {
    throw new ReadError("invalid_path", "Only relative paths within the root are allowed");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ReadError("invalid_limit", "maxBytes must be a positive safe integer");
  }

  // Resolve the root (symlink-aware) and the candidate target.
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new ReadError("no_root", "Configured filesystem root does not exist");
  }

  // Lexical containment FIRST: reject traversal before touching the filesystem, so
  // a `../` escape fails with permission_denied even when the target does not exist.
  const targetLexical = resolve(rootReal, relPath);
  if (targetLexical !== rootReal && !targetLexical.startsWith(rootReal + sep)) {
    throw new ReadError("permission_denied", "Path escapes the configured root");
  }

  // Symlink-aware containment: resolve the target and confirm it still lives under root.
  const targetReal = await realpath(targetLexical).catch(() => {
    throw new ReadError("not_found", "Path does not exist");
  });
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new ReadError("permission_denied", "Path escapes the configured root");
  }

  const info = await stat(targetReal);
  if (!info.isFile()) {
    throw new ReadError("not_found", "Path is not a regular file");
  }
  if (info.size > maxBytes) {
    throw new ReadError("too_large", `File exceeds the ${maxBytes}-byte read limit`);
  }

  const content = await readFile(targetReal, { encoding: "utf-8" });
  return { content, bytes: Buffer.byteLength(content, "utf-8"), encoding: "utf-8" };
}
