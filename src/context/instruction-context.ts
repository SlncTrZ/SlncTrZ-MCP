/**
 * Project Instruction Context — bounded explicit discovery with client-visible provenance.
 * Wing: context | Topic: project-instructions | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 6, ARCHITECTURE §4.12, SECURITY invariant 11, and ADR-009.
 *
 * Instruction text is untrusted context, never authority. The resolver reads only
 * operator-declared files, applies canonical workspace containment, and returns a
 * bounded result whose provenance is safe to expose to an authenticated client.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  assertNonSecretPath,
  isContainedPath,
  resolveBoundaryRoot
} from "../kernel/fs-boundary.js";
import { readContainedFile, ReadError } from "../kernel/fs-read.js";

export const DEFAULT_MAX_INSTRUCTION_FILES = 32;
export const DEFAULT_MAX_INSTRUCTION_FILE_BYTES = 65_536;
export const DEFAULT_MAX_INSTRUCTION_CONTEXT_BYTES = 32_768;
export const MAX_INSTRUCTION_DIRECTORY_DEPTH = 32;

export type InstructionScope = "user" | "workspace" | "directory";
export type InstructionSourceStatus =
  "loaded" | "referenced" | "missing" | "denied" | "invalid_encoding" | "oversized" | "unreadable";

export interface InstructionContextPolicy {
  readonly workspaceRoot: string;
  readonly userFiles: readonly string[];
  readonly workspaceFiles: readonly string[];
  readonly directoryFileNames: readonly string[];
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxContextBytes?: number;
}

export interface InstructionSource {
  readonly sourceId: string;
  readonly scope: InstructionScope;
  /** Logical client-visible path; absolute user paths are intentionally not exposed. */
  readonly path: string;
  readonly precedence: number;
  readonly status: InstructionSourceStatus;
  readonly bytes?: number;
  readonly estimatedTokens?: number;
  readonly sha256?: string;
  readonly modifiedAtMs?: number;
  readonly content?: string;
}

export interface InstructionContextResult {
  readonly targetDirectory: string;
  readonly maxContextBytes: number;
  readonly loadedBytes: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly sources: readonly InstructionSource[];
}

export interface InstructionContextResolver {
  readonly policyHash: string;
  resolve(
    targetDirectory?: string,
    options?: { readonly includeContent?: boolean }
  ): Promise<InstructionContextResult>;
}

interface Candidate {
  readonly scope: InstructionScope;
  readonly actualPath?: string;
  readonly relativePath?: string;
  readonly displayPath: string;
  readonly precedence: number;
  readonly optional: boolean;
}

interface ReadOutcome {
  readonly status: Exclude<InstructionSourceStatus, "loaded" | "referenced"> | "available";
  readonly bytes?: number;
  readonly sha256?: string;
  readonly modifiedAtMs?: number;
  readonly content?: string;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function sourceId(candidate: Candidate): string {
  const identity = `${candidate.scope}:${
    candidate.actualPath ?? candidate.relativePath ?? candidate.displayPath
  }`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function normalizeTargetDirectory(value: string | undefined): string {
  if (value === undefined || value === "" || value === ".") return ".";
  if (
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("\\\\")
  ) {
    throw new RangeError("Instruction target directory must be workspace-relative");
  }
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new RangeError("Instruction target directory escapes the workspace");
  }
  const depth = normalized.split(/[\\/]+/u).filter(Boolean).length;
  if (depth > MAX_INSTRUCTION_DIRECTORY_DEPTH) {
    throw new RangeError("Instruction target directory exceeds depth ceiling");
  }
  return normalized === "" ? "." : normalized;
}

function directoryAncestors(target: string): readonly string[] {
  if (target === ".") return ["."];
  const ancestors: string[] = [];
  let current = target;
  for (;;) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === "." || parent === current) {
      ancestors.push(".");
      break;
    }
    current = parent;
  }
  return ancestors;
}

function sameFile(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<ReadOutcome> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const [info, currentInfo, currentReal] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path)
    ]);
    if (currentInfo.isSymbolicLink() || !sameFile(info, currentInfo) || currentReal !== path) {
      return { status: "denied" };
    }
    if (!info.isFile()) return { status: "unreadable" };
    if (info.size > maxBytes) {
      return {
        status: "oversized",
        bytes: info.size,
        modifiedAtMs: Math.trunc(info.mtimeMs)
      };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(16_384, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      return {
        status: "oversized",
        bytes: total,
        modifiedAtMs: Math.trunc(info.mtimeMs)
      };
    }
    const bytes = Buffer.concat(chunks, total);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        status: "invalid_encoding",
        bytes: total,
        modifiedAtMs: Math.trunc(info.mtimeMs)
      };
    }
    return {
      status: "available",
      bytes: total,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      modifiedAtMs: Math.trunc(info.mtimeMs),
      content
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readCandidate(
  workspaceRootReal: string,
  candidate: Candidate,
  maxFileBytes: number
): Promise<ReadOutcome | undefined> {
  if (candidate.actualPath !== undefined) {
    try {
      assertNonSecretPath(candidate.actualPath);
    } catch {
      return { status: "denied" };
    }
    try {
      const info = await lstat(candidate.actualPath);
      if (info.isSymbolicLink() || !info.isFile()) return { status: "denied" };
      const canonical = await realpath(candidate.actualPath);
      if (canonical !== candidate.actualPath) return { status: "denied" };
      return await readBoundedFile(canonical, maxFileBytes);
    } catch {
      return candidate.optional ? undefined : { status: "missing" };
    }
  }

  try {
    const result = await readContainedFile(
      workspaceRootReal,
      candidate.relativePath ?? "",
      maxFileBytes
    );
    return {
      status: "available",
      bytes: result.bytes,
      sha256: result.sha256,
      content: result.content
    };
  } catch (error) {
    if (candidate.optional && error instanceof ReadError && error.code === "not_found") {
      return undefined;
    }
    if (error instanceof ReadError) {
      return {
        status:
          error.code === "not_found"
            ? "missing"
            : error.code === "too_large"
              ? "oversized"
              : error.code === "invalid_encoding"
                ? "invalid_encoding"
                : error.code === "permission_denied" || error.code === "invalid_path"
                  ? "denied"
                  : "unreadable"
      };
    }
    return candidate.optional ? undefined : { status: "unreadable" };
  }
}

function candidatesFor(
  policy: InstructionContextPolicy,
  targetDirectory: string
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  policy.userFiles.forEach((path, index) => {
    candidates.push({
      scope: "user",
      actualPath: path,
      displayPath: `user/${index + 1}-${basename(path)}`,
      precedence: 300 - index,
      optional: false
    });
  });
  policy.workspaceFiles.forEach((path, index) => {
    candidates.push({
      scope: "workspace",
      relativePath: path,
      displayPath: path,
      precedence: 200 - index,
      optional: false
    });
  });

  const ancestors = directoryAncestors(targetDirectory);
  ancestors.forEach((directory, depthIndex) => {
    policy.directoryFileNames.forEach((name, nameIndex) => {
      const relativePath = directory === "." ? name : join(directory, name);
      if (policy.workspaceFiles.includes(relativePath)) return;
      candidates.push({
        scope: "directory",
        relativePath,
        displayPath: relativePath,
        precedence: 100 - depthIndex * policy.directoryFileNames.length - nameIndex,
        optional: true
      });
    });
  });
  return candidates;
}

/** Build one immutable resolver from policy-validated instruction configuration. */
export function createInstructionContextResolver(
  policy: InstructionContextPolicy
): InstructionContextResolver {
  const maxFiles = positiveSafeInteger(policy.maxFiles, DEFAULT_MAX_INSTRUCTION_FILES, "maxFiles");
  const maxFileBytes = positiveSafeInteger(
    policy.maxFileBytes,
    DEFAULT_MAX_INSTRUCTION_FILE_BYTES,
    "maxFileBytes"
  );
  const maxContextBytes = positiveSafeInteger(
    policy.maxContextBytes,
    DEFAULT_MAX_INSTRUCTION_CONTEXT_BYTES,
    "maxContextBytes"
  );
  if (!isAbsolute(policy.workspaceRoot) && !/^[A-Za-z]:[\\/]/u.test(policy.workspaceRoot)) {
    throw new RangeError("Instruction workspace root must be absolute");
  }
  for (const path of policy.userFiles) {
    if (!isAbsolute(path) && !/^[A-Za-z]:[\\/]/u.test(path)) {
      throw new RangeError("User instruction file must be absolute");
    }
  }

  const frozenPolicy = Object.freeze({
    workspaceRoot: policy.workspaceRoot,
    userFiles: Object.freeze([...policy.userFiles]),
    workspaceFiles: Object.freeze([...policy.workspaceFiles]),
    directoryFileNames: Object.freeze([...policy.directoryFileNames]),
    maxFiles,
    maxFileBytes,
    maxContextBytes
  });
  const policyHash = createHash("sha256")
    .update(JSON.stringify(frozenPolicy))
    .digest("hex")
    .slice(0, 16);

  return Object.freeze({
    policyHash,
    async resolve(
      targetDirectoryValue?: string,
      options?: { readonly includeContent?: boolean }
    ): Promise<InstructionContextResult> {
      const targetDirectory = normalizeTargetDirectory(targetDirectoryValue);
      let workspaceRootReal: string;
      try {
        workspaceRootReal = await resolveBoundaryRoot(frozenPolicy.workspaceRoot);
        const targetReal = resolve(workspaceRootReal, targetDirectory);
        const targetCanonical = await realpath(targetReal);
        if (!isContainedPath(workspaceRootReal, targetCanonical)) {
          throw new RangeError("Instruction target directory escapes the workspace");
        }
        const targetInfo = await lstat(targetCanonical);
        if (!targetInfo.isDirectory()) {
          throw new RangeError("Instruction target must be a directory");
        }
      } catch (error) {
        if (error instanceof RangeError) throw error;
        throw new RangeError("Instruction workspace or target directory is unavailable");
      }

      const includeContent = options?.includeContent ?? true;
      const allCandidates = candidatesFor(frozenPolicy, targetDirectory);
      let truncated = false;
      let loadedBytes = 0;
      const sources: InstructionSource[] = [];

      for (const candidate of allCandidates) {
        if (sources.length >= maxFiles) {
          truncated = true;
          break;
        }
        const outcome = await readCandidate(workspaceRootReal, candidate, maxFileBytes);
        if (outcome === undefined) continue;
        const base = {
          sourceId: sourceId(candidate),
          scope: candidate.scope,
          path: candidate.displayPath,
          precedence: candidate.precedence
        } as const;

        if (outcome.status !== "available") {
          sources.push(
            Object.freeze({
              ...base,
              status: outcome.status,
              ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
              ...(outcome.modifiedAtMs === undefined ? {} : { modifiedAtMs: outcome.modifiedAtMs })
            })
          );
          if (outcome.status === "oversized") truncated = true;
          continue;
        }

        const bytes = outcome.bytes ?? 0;
        const estimatedTokens = Math.ceil(bytes / 4);
        const canLoad = includeContent && loadedBytes + bytes <= maxContextBytes;
        if (!canLoad && includeContent) truncated = true;
        if (canLoad) loadedBytes += bytes;
        sources.push(
          Object.freeze({
            ...base,
            status: canLoad ? "loaded" : "referenced",
            bytes,
            estimatedTokens,
            ...(outcome.sha256 === undefined ? {} : { sha256: outcome.sha256 }),
            ...(outcome.modifiedAtMs === undefined ? {} : { modifiedAtMs: outcome.modifiedAtMs }),
            ...(canLoad ? { content: outcome.content ?? "" } : {})
          })
        );
      }

      return Object.freeze({
        targetDirectory,
        maxContextBytes,
        loadedBytes,
        estimatedTokens: Math.ceil(loadedBytes / 4),
        truncated,
        sources: Object.freeze(sources)
      });
    }
  });
}
