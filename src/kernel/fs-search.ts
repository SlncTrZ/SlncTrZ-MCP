/**
 * Contained Filesystem Search — list files within a configured root matching a pattern.
 * Wing: kernel | Topic: fs-search-tool | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 3 (read-only search companion to core.read) and SECURITY
 * default-deny. Walks the root (symlink-aware, cycle-guarded) and returns relative
 * paths whose name matches a case-insensitive substring. Bounded by result count and
 * depth. Default-deny when no root is configured.
 */

import { readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/** Explicit bounds, never declared inline. */
export const DEFAULT_MAX_SEARCH_RESULTS = 100;
export const DEFAULT_MAX_SEARCH_DEPTH = 6;

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

export type SearchErrorCode = "no_root" | "invalid_pattern" | "invalid_limit";

export interface SearchResult {
  readonly matches: readonly string[];
}

/** Return file paths (relative to `root`) whose name matches `pattern` (case-insensitive). */
export async function searchContainedFiles(
  root: string | undefined,
  pattern: string,
  maxResults: number = DEFAULT_MAX_SEARCH_RESULTS,
  maxDepth: number = DEFAULT_MAX_SEARCH_DEPTH
): Promise<SearchResult> {
  if (root === undefined || root.length === 0) {
    throw new SearchError("no_root", "No filesystem root is configured");
  }
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new SearchError("invalid_pattern", "A non-empty search pattern is required");
  }
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
    throw new SearchError("invalid_limit", "maxResults must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new SearchError("invalid_limit", "maxDepth must be a non-negative safe integer");
  }

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new SearchError("no_root", "Configured filesystem root does not exist");
  }

  const needle = pattern.toLowerCase();
  const matches: string[] = [];
  const seen = new Set<string>([rootReal]);

  async function walk(dirReal: string, relDir: string, depth: number): Promise<void> {
    if (matches.length >= maxResults || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dirReal, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(dirReal, entry.name);
      let entryReal: string;
      try {
        entryReal = await realpath(abs);
      } catch {
        continue; // broken symlink or unreadable — skip
      }
      // Symlink-aware containment: skip anything that resolves outside the root.
      if (entryReal !== rootReal && !entryReal.startsWith(rootReal + sep)) continue;

      if (entry.isDirectory()) {
        if (!seen.has(entryReal)) {
          seen.add(entryReal);
          await walk(entryReal, rel, depth + 1);
        }
      } else if (rel.toLowerCase().includes(needle)) {
        matches.push(rel);
      }
    }
  }

  await walk(rootReal, "", 0);
  return { matches };
}
