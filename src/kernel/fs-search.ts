/**
 * Contained Filesystem Search — bounded deterministic filename discovery.
 * Wing: kernel | Topic: fs-search-tool | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3 and THREAT_MODEL read-only gate. Enumeration uses the
 * shared filesystem boundary, skips protected paths, and is bounded by depth,
 * scanned entries, results, timeout, and cancellation.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  assertNonSecretPath,
  BoundaryError,
  isContainedPath,
  resolveBoundaryRoot
} from "./fs-boundary.js";
import { createExecutionGuard, type KernelExecutionOptions } from "./execution.js";

export const DEFAULT_MAX_SEARCH_RESULTS = 100;
export const DEFAULT_MAX_SEARCH_DEPTH = 6;
export const DEFAULT_MAX_SEARCH_ENTRIES = 10_000;

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

export type SearchErrorCode = "no_root" | "invalid_pattern" | "invalid_limit" | "permission_denied";

export interface SearchOptions extends KernelExecutionOptions {
  readonly maxResults?: number;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface SearchResult {
  readonly matches: readonly string[];
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

function validateLimit(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new SearchError(
      "invalid_limit",
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`
    );
  }
}

function compareNames(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Return deterministic relative paths whose name contains the case-insensitive pattern. */
export async function searchContainedFiles(
  root: string | undefined,
  pattern: string,
  options: SearchOptions = {}
): Promise<SearchResult> {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new SearchError("invalid_pattern", "A non-empty search pattern is required");
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_SEARCH_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_SEARCH_ENTRIES;
  validateLimit(maxResults, "maxResults");
  validateLimit(maxDepth, "maxDepth", true);
  validateLimit(maxEntries, "maxEntries");

  const guard = createExecutionGuard(options);
  guard.checkpoint();

  let rootReal: string;
  try {
    rootReal = await resolveBoundaryRoot(root);
  } catch (error) {
    if (error instanceof BoundaryError) {
      throw new SearchError(
        error.code === "no_root" ? "no_root" : "permission_denied",
        error.message
      );
    }
    throw error;
  }

  const needle = pattern.toLowerCase();
  const matches: string[] = [];
  const seen = new Set<string>([rootReal]);
  let scannedEntries = 0;
  let truncated = false;

  async function walk(dirReal: string, relDir: string, depth: number): Promise<void> {
    guard.checkpoint();
    if (matches.length >= maxResults || scannedEntries >= maxEntries) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort(compareNames);

    for (const entry of entries) {
      guard.checkpoint();
      if (matches.length >= maxResults || scannedEntries >= maxEntries) {
        truncated = true;
        return;
      }
      scannedEntries += 1;

      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      try {
        assertNonSecretPath(rel);
      } catch (error) {
        if (error instanceof BoundaryError) continue;
        throw error;
      }

      const abs = join(dirReal, entry.name);
      let entryReal: string;
      try {
        entryReal = await realpath(abs);
      } catch {
        continue;
      }
      if (!isContainedPath(rootReal, entryReal)) continue;

      let info;
      try {
        info = await stat(entryReal);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        if (depth >= maxDepth) {
          truncated = true;
        } else if (!seen.has(entryReal)) {
          seen.add(entryReal);
          await walk(entryReal, rel, depth + 1);
        }
      } else if (info.isFile() && rel.toLowerCase().includes(needle)) {
        matches.push(rel.split(sep).join("/"));
      }
    }
  }

  await walk(rootReal, "", 0);
  return { matches, scannedEntries, truncated };
}
