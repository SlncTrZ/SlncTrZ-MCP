/**
 * Deterministic Exact-Match Filesystem Edit — thin orchestration over the shared read/write kernels.
 * Wing: kernel | Topic: fs-edit-tool | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3, ARCHITECTURE §4.9, THREAT_MODEL mutation gate, and ADR-016.
 *
 * core.edit only performs exact-match replacements against one immutable base snapshot.
 * Path containment, secret-path denial, atomic publication, mode preservation, target
 * serialization, and authentication are all delegated to readContainedFile() and
 * writeContainedFile(). This module owns only deterministic matching, ambiguity/overlap
 * rejection, bounded structured diff, and result assembly.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createExecutionGuard, type KernelExecutionOptions } from "./execution.js";
import { resolveWritableBoundaryPath } from "./fs-boundary.js";
import { ReadError, readContainedFile, type ReadResult } from "./fs-read.js";
import { WriteError, writeContainedFile, type WriteResult } from "./fs-write.js";

export const DEFAULT_MAX_EDIT_OPERATIONS = 64;
export const DEFAULT_MAX_EDIT_BYTES = 1_048_576;
export const DEFAULT_MAX_EDIT_INPUT_BYTES = 1_048_576;
export const DEFAULT_MAX_DIFF_BYTES = 65_536;

const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

export type EditErrorCode =
  | "no_root"
  | "invalid_path"
  | "not_found"
  | "permission_denied"
  | "not_file"
  | "too_large"
  | "invalid_encoding"
  | "invalid_limit"
  | "expected_hash_required"
  | "conflict"
  | "invalid_edit"
  | "too_many_edits"
  | "match_not_found"
  | "ambiguous_match"
  | "overlapping_edits"
  | "no_change";

export class EditError extends Error {
  readonly code: EditErrorCode;

  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
  }
}

export interface ExactTextEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface EditOptions extends KernelExecutionOptions {
  readonly dryRun?: boolean;
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
  readonly maxEdits?: number;
  readonly maxDiffBytes?: number;
}

export interface EditDiffHunk {
  readonly startLine: number;
  readonly oldText: string;
  readonly newText: string;
}

export interface EditResult {
  readonly path: string;
  readonly editCount: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly previousSha256: string;
  readonly sha256: string;
  readonly applied: boolean;
  readonly diff: {
    readonly format: "exact-replacements-v1";
    readonly hunks: readonly EditDiffHunk[];
    readonly truncated: boolean;
    readonly omittedHunks: number;
  };
}

interface ResolvedEdit {
  readonly start: number;
  readonly end: number;
  readonly oldText: string;
  readonly newText: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Classify a read `not_found` into a missing target versus an existing non-regular-file. */
async function classifyTargetFailure(
  root: string | undefined,
  relPath: string
): Promise<"not_found" | "not_file"> {
  try {
    const boundary = await resolveWritableBoundaryPath(root, relPath);
    if (!boundary.exists) return "not_found";
    const info = await lstat(boundary.targetPath);
    return info.isFile() ? "not_found" : "not_file";
  } catch {
    return "not_found";
  }
}

async function mapReadError(
  error: ReadError,
  root: string | undefined,
  relPath: string
): Promise<EditError> {
  if (error.code === "not_found") {
    const kind = await classifyTargetFailure(root, relPath);
    return new EditError(
      kind,
      kind === "not_file" ? "Target is not a regular file" : "Target does not exist"
    );
  }
  return new EditError(error.code, error.message);
}

function mapWriteError(error: WriteError): EditError {
  return new EditError(error.code, error.message);
}

function resolveEditContent(
  content: string,
  edits: readonly ExactTextEdit[],
  guard: { readonly checkpoint: () => void }
): readonly ResolvedEdit[] {
  const resolved: ResolvedEdit[] = [];
  for (const edit of edits) {
    guard.checkpoint();
    const start = content.indexOf(edit.oldText);
    if (start === -1) {
      throw new EditError("match_not_found", "oldText does not occur in the target");
    }
    if (content.indexOf(edit.oldText, start + 1) !== -1) {
      throw new EditError("ambiguous_match", "oldText occurs more than once");
    }
    resolved.push({
      start,
      end: start + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText
    });
  }
  return resolved;
}

function assertNoOverlap(resolved: readonly ResolvedEdit[]): void {
  let previous: ResolvedEdit | undefined;
  for (const current of resolved) {
    if (previous !== undefined && current.start < previous.end) {
      throw new EditError("overlapping_edits", "Edits resolve to intersecting spans");
    }
    previous = current;
  }
}

function composeResult(content: string, resolved: readonly ResolvedEdit[]): string {
  let output = "";
  let cursor = 0;
  for (const edit of resolved) {
    output += content.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return output + content.slice(cursor);
}

function buildDiff(
  content: string,
  resolved: readonly ResolvedEdit[],
  maxDiffBytes: number
): EditResult["diff"] {
  const hunks: EditDiffHunk[] = [];
  let usedBytes = 0;
  let truncated = false;
  let omittedHunks = 0;

  for (const edit of resolved) {
    const hunkBytes = byteLength(edit.oldText) + byteLength(edit.newText);
    if (usedBytes + hunkBytes > maxDiffBytes) {
      truncated = true;
      omittedHunks += 1;
      continue;
    }
    hunks.push({
      startLine: lineNumberAt(content, edit.start),
      oldText: edit.oldText,
      newText: edit.newText
    });
    usedBytes += hunkBytes;
  }

  return {
    format: "exact-replacements-v1",
    hunks,
    truncated,
    omittedHunks
  };
}

/**
 * Apply a bounded set of exact-match replacements to one existing file.
 * Mutates only when `options.dryRun` is exactly false; otherwise returns a preview.
 */
export async function editContainedFile(
  root: string | undefined,
  relPath: string,
  edits: readonly ExactTextEdit[],
  options: EditOptions = {}
): Promise<EditResult> {
  // Step 1 — validate before any I/O.
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_EDIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new EditError("invalid_limit", "maxBytes must be a positive safe integer");
  }
  const maxEdits = options.maxEdits ?? DEFAULT_MAX_EDIT_OPERATIONS;
  if (!Number.isSafeInteger(maxEdits) || maxEdits <= 0) {
    throw new EditError("invalid_limit", "maxEdits must be a positive safe integer");
  }
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes <= 0) {
    throw new EditError("invalid_limit", "maxDiffBytes must be a positive safe integer");
  }

  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditError("invalid_edit", "At least one edit operation is required");
  }
  if (edits.length > maxEdits) {
    throw new EditError("too_many_edits", `Edit count exceeds the ${maxEdits}-operation limit`);
  }

  let aggregateInputBytes = 0;
  for (const edit of edits) {
    if (
      typeof edit !== "object" ||
      edit === null ||
      typeof edit.oldText !== "string" ||
      typeof edit.newText !== "string"
    ) {
      throw new EditError("invalid_edit", "Each edit requires string oldText and newText");
    }
    if (edit.oldText.length === 0) {
      throw new EditError("invalid_edit", "oldText must not be empty");
    }
    if (edit.oldText === edit.newText) {
      throw new EditError("invalid_edit", "oldText must differ from newText");
    }
    aggregateInputBytes += byteLength(edit.oldText) + byteLength(edit.newText);
    if (aggregateInputBytes > DEFAULT_MAX_EDIT_INPUT_BYTES) {
      throw new EditError("too_large", "Aggregate edit input exceeds the byte limit");
    }
  }

  if (options.expectedSha256 === undefined) {
    throw new EditError("expected_hash_required", "expectedSha256 is required");
  }
  if (!SHA256_PATTERN.test(options.expectedSha256)) {
    throw new EditError("invalid_edit", "expectedSha256 must be a SHA-256 hex digest");
  }

  const guard = createExecutionGuard(options);

  // Step 2 — read through the shared, canonical, secret-denying boundary.
  guard.checkpoint();
  let read: ReadResult;
  try {
    read = await readContainedFile(root, relPath, maxBytes, options);
  } catch (error) {
    if (error instanceof ReadError) {
      throw await mapReadError(error, root, relPath);
    }
    throw error;
  }
  guard.checkpoint();

  // Step 3 — verify the base hash before revealing match results.
  const expectedSha256 = options.expectedSha256.toLowerCase();
  if (expectedSha256 !== read.sha256) {
    throw new EditError("conflict", "Base hash is stale");
  }

  // Steps 4-5 — resolve against original content and reject ambiguity and overlap.
  const resolved = [...resolveEditContent(read.content, edits, guard)].sort(
    (a, b) => a.start - b.start
  );
  assertNoOverlap(resolved);

  // Step 6 — apply deterministically against the original content.
  const bodyContent = composeResult(read.content, resolved);
  guard.checkpoint();
  if (bodyContent === read.content) {
    throw new EditError("no_change", "Result equals source");
  }
  // Preserve an original UTF-8 BOM that the strict decoder stripped from the content.
  const editedContent = read.hadBom ? `\uFEFF${bodyContent}` : bodyContent;
  const editedBytes = byteLength(editedContent);
  if (editedBytes > maxBytes) {
    throw new EditError("too_large", `Result exceeds the ${maxBytes}-byte limit`);
  }
  const nextSha256 = sha256(editedContent);

  // Step 8 — build a bounded structured diff over the caller-supplied spans.
  const diff = buildDiff(read.content, resolved, maxDiffBytes);

  const dryRun = options.dryRun !== false;

  // Step 9 — commit through the existing atomic writer.
  guard.checkpoint();
  let writeResult: WriteResult;
  try {
    writeResult = await writeContainedFile(root, relPath, editedContent, {
      expectedSha256: options.expectedSha256,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      maxBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
  } catch (error) {
    if (error instanceof WriteError) throw mapWriteError(error);
    throw error;
  }
  guard.checkpoint();

  // Editing must never create a file; a freshly-created write target means it disappeared.
  if (writeResult.created) {
    throw new EditError("conflict", "Target disappeared during processing");
  }
  if (
    dryRun &&
    writeResult.previousSha256 !== undefined &&
    writeResult.previousSha256 !== read.sha256
  ) {
    throw new EditError("conflict", "Target changed during processing");
  }

  return {
    path: writeResult.path,
    editCount: edits.length,
    bytesBefore: read.bytes,
    bytesAfter: editedBytes,
    previousSha256: read.sha256,
    sha256: nextSha256,
    applied: writeResult.applied,
    diff
  };
}
