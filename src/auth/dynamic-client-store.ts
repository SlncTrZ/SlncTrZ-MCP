/**
 * Durable Dynamic OAuth Client Store — strict, bounded, secret-free registration persistence.
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
import type { DynamicClientRecord } from "./oauth-service.js";

const recordSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    clientName: z.string().min(1).max(128).optional(),
    redirectUris: z.array(z.string().min(1).max(2_048)).min(1).max(10),
    issuedAt: z.number().int().nonnegative()
  })
  .strict();

export interface DynamicClientFileStore {
  load(): readonly DynamicClientRecord[];
  save(clients: readonly DynamicClientRecord[]): void;
}

function validateRecords(raw: unknown, maxClients: number): DynamicClientRecord[] {
  const parsed = z.array(recordSchema).max(maxClients).safeParse(raw);
  if (!parsed.success) throw new Error("oauth_client_store_invalid_schema");
  const seen = new Set<string>();
  for (const record of parsed.data) {
    if (seen.has(record.clientId)) throw new Error("oauth_client_store_duplicate_client");
    seen.add(record.clientId);
  }
  return parsed.data.map((record) => ({
    clientId: record.clientId,
    ...(record.clientName === undefined ? {} : { clientName: record.clientName }),
    redirectUris: [...record.redirectUris],
    issuedAt: record.issuedAt
  }));
}

function assertPrivateFile(path: string): void {
  if (process.platform === "win32") {
    ensureWindowsPrivateAcl(path, "file");
    return;
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error("oauth_client_store_permissions_too_broad");
}

export function createDynamicClientFileStore(
  path: string,
  maxClients: number
): DynamicClientFileStore {
  if (!Number.isSafeInteger(maxClients) || maxClients <= 0) {
    throw new RangeError("maxClients must be a positive safe integer");
  }

  return Object.freeze({
    load() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      assertPrivateFile(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error("oauth_client_store_invalid_json");
      }
      return validateRecords(parsed, maxClients);
    },
    save(clients: readonly DynamicClientRecord[]) {
      const records = validateRecords(clients, maxClients);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      ensureWindowsPrivateAcl(directory, "directory");
      const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(records)}\n`, {
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
  });
}
