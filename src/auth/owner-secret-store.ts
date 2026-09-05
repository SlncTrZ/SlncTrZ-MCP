/**
 * Owner Secret Store — persistent plaintext recovery secret with verifier derivation.
 *
 * The managed plaintext file is the default recovery path and source of truth. A legacy
 * SLNCTRZ_OWNER_SECRET_HASH is only a compatibility override and never replaces the recovery
 * path; an env-hash-only state (no plaintext file) is treated as a degraded/migration state
 * and is migrated to a fresh plaintext file rather than being silently accepted as normal.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";
import { createOwnerSecretHash, validateOwnerSecretHash } from "./owner-verifier.js";

const GENERATED_SECRET_LENGTH = 32;

function stripSingleLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function generateSecret(): string {
  return randomBytes(Math.ceil((GENERATED_SECRET_LENGTH * 3) / 4))
    .toString("base64url")
    .slice(0, GENERATED_SECRET_LENGTH);
}

async function assertSecretFileMode(path: string): Promise<void> {
  if (process.platform === "win32") {
    ensureWindowsPrivateAcl(path, "file");
    return;
  }
  const info = await stat(path);
  const mode = info.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error("Owner passphrase file must have mode 0600");
  }
}

async function readStoredSecret(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    await assertSecretFileMode(path);
    const secret = stripSingleLineEnding(await readFile(path, "utf8"));
    // Reuse the verifier's strict length validation without retaining the derived value.
    createOwnerSecretHash(secret);
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface ResolvedOwnerSecret {
  readonly ownerSecretHash: string;
  readonly source: "file" | "generated" | "migrated" | "environment";
  /** Non-secret managed recovery path when a plaintext recovery file exists. */
  readonly recoveryFile?: string;
  /** Present only when legacy env-hash state was replaced by a managed recovery passphrase. */
  readonly migratedFrom?: "environment-hash";
}

/**
 * Resolve owner authentication material for startup.
 * Priority: managed plaintext file -> generate + persist a recoverable file (migrating an
 * env-hash-only state); the legacy verifier env is last resort only when the file is unwritable.
 */
export async function resolveOwnerSecret(options: {
  readonly secretFile: string;
  readonly environmentHash?: string;
}): Promise<ResolvedOwnerSecret> {
  const stored = await readStoredSecret(options.secretFile);
  if (stored !== undefined) {
    return {
      ownerSecretHash: createOwnerSecretHash(stored),
      source: "file",
      recoveryFile: options.secretFile
    };
  }

  const envHash =
    options.environmentHash !== undefined && options.environmentHash.length > 0
      ? options.environmentHash
      : undefined;
  if (envHash !== undefined) validateOwnerSecretHash(envHash);

  const secret = generateSecret();
  const secretDirectory = dirname(options.secretFile);
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  ensureWindowsPrivateAcl(secretDirectory, "directory");
  try {
    await writeFile(options.secretFile, `${secret}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      // Truly unwritable: fall back to the legacy verifier env only as a last resort.
      if (envHash !== undefined) return { ownerSecretHash: envHash, source: "environment" };
      throw error;
    }
    const raced = await readStoredSecret(options.secretFile);
    if (raced === undefined) throw error;
    return {
      ownerSecretHash: createOwnerSecretHash(raced),
      source: "file",
      recoveryFile: options.secretFile
    };
  }
  if (process.platform !== "win32") await chmod(options.secretFile, 0o600);
  else ensureWindowsPrivateAcl(options.secretFile, "file");

  if (envHash !== undefined) {
    // Env-hash-only state (no plaintext recovery file) is a degraded/migration state; we rebuilt
    // a recoverable plaintext file. Surfaced via source="migrated" so the caller can warn.
    return {
      ownerSecretHash: createOwnerSecretHash(secret),
      source: "migrated",
      recoveryFile: options.secretFile,
      migratedFrom: "environment-hash"
    };
  }
  return {
    ownerSecretHash: createOwnerSecretHash(secret),
    source: "generated",
    recoveryFile: options.secretFile
  };
}
