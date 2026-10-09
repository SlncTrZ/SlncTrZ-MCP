/**
 * Workspace Preference Store — durable owner workspace display name.
 * Wing: owner | Topic: workspace-preference | Updated: 2026-10-09 22:45
 *
 * A small versioned file (`workspace-preference.json`) in the owner state root holds the
 * display-only workspace name. This is a presentation preference: it never affects the kernel
 * workspace identity, provider ids, tool grants or permissions. Missing files resolve to the
 * default name without creating the file; corrupt files fail closed with a typed error instead
 * of being silently overwritten.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_WORKSPACE_DISPLAY_NAME = "Owner workspace";
const MAX_DISPLAY_NAME_CODE_POINTS = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type WorkspacePreferenceErrorCode = "invalid_display_name" | "preference_corrupt";

export class WorkspacePreferenceError extends Error {
  readonly code: WorkspacePreferenceErrorCode;

  constructor(code: WorkspacePreferenceErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePreferenceError";
    this.code = code;
  }
}

export interface WorkspacePreference {
  readonly displayName: string;
}

export interface WorkspacePreferenceStore {
  get(): Promise<WorkspacePreference>;
  setDisplayName(displayName: string): Promise<WorkspacePreference>;
}

/** Trim, count Unicode code points and reject control characters; undefined when invalid. */
function normalizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const codePoints = [...trimmed];
  if (codePoints.length < 1 || codePoints.length > MAX_DISPLAY_NAME_CODE_POINTS) {
    return undefined;
  }
  if (CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/** Validate a caller-supplied display name; throws a typed error for invalid input. */
export function validateDisplayName(raw: unknown): string {
  const normalized = normalizeDisplayName(raw);
  if (normalized === undefined) {
    throw new WorkspacePreferenceError(
      "invalid_display_name",
      "Display name must be 1-64 characters with no control characters"
    );
  }
  return normalized;
}

function parseStored(raw: string): WorkspacePreference {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WorkspacePreferenceError(
      "preference_corrupt",
      "workspace-preference.json is not valid JSON"
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspacePreferenceError(
      "preference_corrupt",
      "workspace-preference.json has an invalid shape"
    );
  }
  const normalized = normalizeDisplayName((parsed as { displayName?: unknown }).displayName);
  if (normalized === undefined) {
    throw new WorkspacePreferenceError(
      "preference_corrupt",
      "workspace-preference.json displayName is invalid"
    );
  }
  return Object.freeze({ displayName: normalized });
}

async function loadFile(path: string): Promise<WorkspacePreference | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseStored(raw);
}

async function atomicWrite(path: string, preference: WorkspacePreference): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const body = `${JSON.stringify(
    { schemaVersion: 1, displayName: preference.displayName },
    null,
    2
  )}\n`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function createWorkspacePreferenceStore(file: string): WorkspacePreferenceStore {
  return Object.freeze({
    async get() {
      const stored = await loadFile(file);
      return stored ?? Object.freeze({ displayName: DEFAULT_WORKSPACE_DISPLAY_NAME });
    },
    async setDisplayName(displayName: string) {
      const normalized = validateDisplayName(displayName);
      // Detect a corrupt existing file before overwriting it — corrupt state requires owner action.
      await loadFile(file);
      const next = Object.freeze({ displayName: normalized });
      await atomicWrite(file, next);
      return next;
    }
  });
}
