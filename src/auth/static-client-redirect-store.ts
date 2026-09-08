/**
 * Durable Static OAuth Redirect Store — owner-approved, exact, secret-free callbacks.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import * as z from "zod/v4";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";

const MAX_CLIENT_RECORDS = 64;
export const MAX_STATIC_CLIENT_REDIRECT_URIS = 10;

const recordSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    redirectUris: z.array(z.string().min(1).max(2_048)).max(MAX_STATIC_CLIENT_REDIRECT_URIS),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    clients: z.array(recordSchema).max(MAX_CLIENT_RECORDS)
  })
  .strict();

interface StaticClientRedirectRecord {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly updatedAt: number;
}

interface StaticClientRedirectDocument {
  readonly schemaVersion: 1;
  readonly clients: readonly StaticClientRedirectRecord[];
}

export interface StaticClientRedirectStore {
  load(clientId: string): readonly string[];
  add(clientId: string, redirectUri: string, updatedAt: number): readonly string[];
}

function validateDocument(raw: unknown): StaticClientRedirectDocument {
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) throw new Error("oauth_static_redirect_store_invalid_schema");

  const clientIds = new Set<string>();
  for (const record of parsed.data.clients) {
    if (clientIds.has(record.clientId)) {
      throw new Error("oauth_static_redirect_store_duplicate_client");
    }
    clientIds.add(record.clientId);
    if (new Set(record.redirectUris).size !== record.redirectUris.length) {
      throw new Error("oauth_static_redirect_store_duplicate_redirect");
    }
  }

  return {
    schemaVersion: 1,
    clients: parsed.data.clients.map((record) => ({
      clientId: record.clientId,
      redirectUris: [...record.redirectUris],
      updatedAt: record.updatedAt
    }))
  };
}

function assertPrivateFile(path: string): void {
  if (process.platform === "win32") {
    ensureWindowsPrivateAcl(path, "file");
    return;
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("oauth_static_redirect_store_permissions_too_broad");
  }
}

function readDocument(path: string): StaticClientRedirectDocument {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, clients: [] };
    }
    throw error;
  }
  assertPrivateFile(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("oauth_static_redirect_store_invalid_json");
  }
  return validateDocument(parsed);
}

function writeDocument(path: string, document: StaticClientRedirectDocument): void {
  const validated = validateDocument(document);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureWindowsPrivateAcl(directory, "directory");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    else ensureWindowsPrivateAcl(path, "file");
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createStaticClientRedirectStore(path: string): StaticClientRedirectStore {
  return Object.freeze({
    load(clientId: string) {
      return [
        ...(readDocument(path).clients.find((record) => record.clientId === clientId)
          ?.redirectUris ?? [])
      ];
    },
    add(clientId: string, redirectUri: string, updatedAt: number) {
      if (clientId.length === 0 || clientId.length > 256) {
        throw new Error("oauth_static_redirect_store_invalid_client");
      }
      if (redirectUri.length === 0 || redirectUri.length > 2_048) {
        throw new Error("oauth_static_redirect_store_invalid_redirect");
      }
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new Error("oauth_static_redirect_store_invalid_timestamp");
      }

      const current = readDocument(path);
      const existing = current.clients.find((record) => record.clientId === clientId);
      if (existing?.redirectUris.includes(redirectUri)) return [...existing.redirectUris];

      const redirectUris = [...(existing?.redirectUris ?? []), redirectUri];
      if (redirectUris.length > MAX_STATIC_CLIENT_REDIRECT_URIS) {
        throw new Error("oauth_static_redirect_store_capacity_exhausted");
      }

      const clients = current.clients.filter((record) => record.clientId !== clientId);
      clients.push({ clientId, redirectUris, updatedAt });
      writeDocument(path, { schemaVersion: 1, clients });
      return redirectUris;
    }
  });
}
