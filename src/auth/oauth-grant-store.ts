/** Hash-only OAuth grant persistence. All timestamps are Unix seconds.
 * One authority database, SQLite WAL, atomic refresh, bounded live rows, fail closed.
 */
import { closeSync, chmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/v4";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";
import {
  resolveSurfaceProfile,
  validateSurfaceProfile,
  type AuthenticatedConnection,
  type SurfaceProfile
} from "./connection-profile.js";

const SCHEMA_VERSION = 2;
const idSchema = z.string().min(1).max(256);
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const profileSchema = z.enum(["full", "gateway-only"]);
const labelSchema = z.string().min(1).max(64);
/** Owner-managed display name. Backend identity stays grantId/clientId; label is cosmetic only. */
export function validateConnectionLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_connection_label");
  const label = value.trim();
  if (!labelSchema.safeParse(label).success) throw new Error("invalid_connection_label");
  return label;
}
const grantSchema = z.object({
  grantId: idSchema,
  clientId: idSchema,
  resource: z.string().url().max(2048),
  scopes: z.array(z.string().min(1).max(256)).min(1).max(32),
  surfaceProfile: profileSchema,
  label: labelSchema,
  createdAt: timeSchema,
  lastSeenAt: timeSchema
});
const tokenSchema = z.object({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(["access", "refresh"]),
  expiresAt: timeSchema
});
export interface GrantRecord extends AuthenticatedConnection {
  readonly label: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}
export interface StoredToken {
  readonly tokenHash: string;
  readonly kind: "access" | "refresh";
  readonly expiresAt: number;
}
export interface VerifiedGrantToken extends GrantRecord {
  readonly expiresAt: number;
}
export interface NewGrant {
  readonly grantId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  /** Client request is a reduction only, intersected with the owner default. */
  readonly requestedProfile?: SurfaceProfile;
  /** Optional initial display label; defaults to the next free "Agent N" name. */
  readonly label?: string;
}
export interface OAuthGrantStore {
  issue(grant: NewGrant, tokens: readonly StoredToken[], now: number): void;
  rotate(
    refreshHash: string,
    clientId: string,
    resource: string,
    tokens: readonly StoredToken[],
    now: number
  ): boolean;
  findToken(hash: string, kind: "access" | "refresh", now: number): VerifiedGrantToken | undefined;
  restrictByAccessToken(
    hash: string,
    profile: SurfaceProfile,
    now: number
  ): AuthenticatedConnection;
  listConnections(now: number): readonly GrantRecord[];
  setConnectionLabel(grantId: string, label: string, now: number): void;
  getClientDefault(clientId: string): SurfaceProfile | undefined;
  setClientDefault(clientId: string, profile: SurfaceProfile): void;
  setGrantProfile(grantId: string, profile: SurfaceProfile, now: number): void;
  revokeGrant(grantId: string): boolean;
  revokeClient(clientId: string): void;
  revokeAll(): void;
  hasClient(clientId: string, now: number): boolean;
  prune(now: number): void;
  close(): void;
}
interface StoreOptions {
  readonly maxTokens?: number;
  readonly maxClientDefaults?: number;
}
function validTime(now: number): void {
  if (!timeSchema.safeParse(now).success) throw new Error("oauth_grant_store_invalid_time");
}
function grantFromRow(row: Record<string, unknown>): GrantRecord {
  try {
    const parsed = grantSchema.parse({ ...row, scopes: JSON.parse(String(row.scopes)) as unknown });
    return { ...parsed, connectionId: parsed.grantId };
  } catch {
    throw new Error("oauth_grant_store_invalid_record");
  }
}
function secureFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error("oauth_grant_store_invalid_path");
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
  ensureWindowsPrivateAcl(path, "file");
}
function preparePath(path: string): void {
  if (path === ":memory:") return;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureWindowsPrivateAcl(directory, "directory");
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const candidate of [path, path + "-wal", path + "-shm"]) {
    if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) secureFile(candidate);
  }
}
/** Omit path only for explicitly ephemeral service/test usage. Production passes stateRoot path.
 * Caller owns the handle and closes it during shutdown; never silently falls back on disk failure.
 */
export function createSqliteOAuthGrantStore(
  path = ":memory:",
  options: StoreOptions = {}
): OAuthGrantStore {
  const maxTokens = options.maxTokens ?? 50_000;
  const maxDefaults = options.maxClientDefaults ?? 1_024;
  for (const limit of [maxTokens, maxDefaults]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("oauth_grant_store_invalid_capacity");
  }
  let db: DatabaseSync;
  preparePath(path);
  try {
    db = new DatabaseSync(path);
  } catch {
    throw new Error("oauth_grant_store_open_failed");
  }
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION)
      throw new Error("unsupported_schema");
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"
    );
    if (version === 0) {
      // A nonempty unversioned file is not a migration source. Never repair over unknown data.
      if (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .get()
      ) {
        throw new Error("unversioned_schema");
      }
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE client_defaults (
          clientId TEXT PRIMARY KEY, surfaceProfile TEXT NOT NULL CHECK(surfaceProfile IN ('full','gateway-only'))
        ) STRICT;
        CREATE TABLE grants (
          grantId TEXT PRIMARY KEY, clientId TEXT NOT NULL, resource TEXT NOT NULL,
          scopes TEXT NOT NULL, surfaceProfile TEXT NOT NULL CHECK(surfaceProfile IN ('full','gateway-only')),
          label TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE tokens (
          tokenHash TEXT PRIMARY KEY CHECK(length(tokenHash)=64),
          kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
          grantId TEXT NOT NULL REFERENCES grants(grantId) ON DELETE CASCADE,
          expiresAt INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX tokens_expiry ON tokens(expiresAt);
        CREATE INDEX tokens_grant ON tokens(grantId);
        CREATE INDEX grants_client ON grants(clientId);
        PRAGMA user_version=2;
        COMMIT;
      `);
    }
    if (version === 1) {
      // v1 grants predate display labels. Backfill stable "Agent N" names in creation order.
      transaction(() => {
        db.exec("ALTER TABLE grants ADD COLUMN label TEXT NOT NULL DEFAULT ''");
        const rows = db.prepare("SELECT grantId FROM grants ORDER BY createdAt, grantId").all() as {
          readonly grantId: string;
        }[];
        const rename = db.prepare("UPDATE grants SET label=? WHERE grantId=?");
        rows.forEach((row, index) => rename.run(`Agent ${index + 1}`, row.grantId));
        db.exec("PRAGMA user_version=2");
      });
    }
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get() !== undefined
    )
      throw new Error("invalid_database");
    // Verify required tables/columns even for a versioned but malformed file.
    db.prepare("SELECT clientId, surfaceProfile FROM client_defaults LIMIT 0").all();
    db.prepare(
      "SELECT grantId, clientId, resource, scopes, surfaceProfile, label, createdAt, lastSeenAt FROM grants LIMIT 0"
    ).all();
    db.prepare("SELECT tokenHash, kind, grantId, expiresAt FROM tokens LIMIT 0").all();
    if (path !== ":memory:") {
      for (const candidate of [path, path + "-wal", path + "-shm"]) {
        if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) secureFile(candidate);
      }
    }
  } catch {
    db.close();
    throw new Error("oauth_grant_store_invalid_database");
  }
  let closed = false;
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function prune(now: number): void {
    validTime(now);
    db.prepare("DELETE FROM tokens WHERE expiresAt <= ?").run(now);
    db.exec(
      "DELETE FROM grants WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.grantId=grants.grantId)"
    );
  }
  function getDefault(clientId: string): SurfaceProfile | undefined {
    const row = db
      .prepare("SELECT surfaceProfile FROM client_defaults WHERE clientId=?")
      .get(clientId);
    return row === undefined ? undefined : validateSurfaceProfile(row.surfaceProfile);
  }
  function find(
    hash: string,
    kind: "access" | "refresh",
    now: number
  ): VerifiedGrantToken | undefined {
    validTime(now);
    const row = db
      .prepare(
        `
      SELECT g.*, t.expiresAt FROM tokens t JOIN grants g ON g.grantId=t.grantId
      WHERE t.tokenHash=? AND t.kind=? AND t.expiresAt>?
    `
      )
      .get(hash, kind, now);
    if (row === undefined) return undefined;
    const expiresAt = timeSchema.safeParse(row.expiresAt);
    if (!expiresAt.success) throw new Error("oauth_grant_store_invalid_record");
    return { ...grantFromRow(row), expiresAt: expiresAt.data };
  }
  function insertTokens(grantId: string, tokens: readonly StoredToken[], now: number): void {
    if (tokens.length !== 2 || tokens[0]?.kind !== "access" || tokens[1]?.kind !== "refresh") {
      throw new Error("oauth_grant_store_invalid_tokens");
    }
    const count = Number(db.prepare("SELECT count(*) AS n FROM tokens").get()?.n);
    if (count + tokens.length > maxTokens) throw new Error("oauth_grant_store_capacity");
    for (const token of tokens) {
      if (!tokenSchema.safeParse(token).success || token.expiresAt <= now) {
        throw new Error("oauth_grant_store_invalid_tokens");
      }
      db.prepare("INSERT INTO tokens(tokenHash, kind, grantId, expiresAt) VALUES(?,?,?,?)").run(
        token.tokenHash,
        token.kind,
        grantId,
        token.expiresAt
      );
    }
  }
  return {
    issue(grant, tokens, now) {
      transaction(() => {
        prune(now);
        const defaultProfile = resolveSurfaceProfile(undefined, getDefault(grant.clientId));
        const requested = grant.requestedProfile;
        if (requested !== undefined) validateSurfaceProfile(requested);
        const surfaceProfile =
          defaultProfile === "gateway-only" || requested === "gateway-only"
            ? "gateway-only"
            : "full";
        const existing = db.prepare("SELECT label FROM grants").all() as {
          readonly label: string;
        }[];
        let maxAgent = 0;
        for (const row of existing) {
          const match = /^Agent (\d+)$/.exec(row.label);
          if (match) maxAgent = Math.max(maxAgent, Number(match[1]));
        }
        const label =
          grant.label === undefined
            ? `Agent ${maxAgent + 1}`
            : validateConnectionLabel(grant.label);
        const parsed = grantSchema.safeParse({
          ...grant,
          surfaceProfile,
          label,
          createdAt: now,
          lastSeenAt: now
        });
        if (!parsed.success) throw new Error("oauth_grant_store_invalid_grant");
        db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?)").run(
          grant.grantId,
          grant.clientId,
          grant.resource,
          JSON.stringify(grant.scopes),
          surfaceProfile,
          label,
          now,
          now
        );
        insertTokens(grant.grantId, tokens, now);
      });
    },
    rotate(refreshHash, clientId, resource, tokens, now) {
      return transaction(() => {
        prune(now);
        const grant = find(refreshHash, "refresh", now);
        if (grant === undefined || grant.clientId !== clientId || grant.resource !== resource)
          return false;
        db.prepare("DELETE FROM tokens WHERE tokenHash=?").run(refreshHash);
        insertTokens(grant.grantId, tokens, now);
        db.prepare("UPDATE grants SET lastSeenAt=? WHERE grantId=?").run(now, grant.grantId);
        return true;
      });
    },
    findToken(hash, kind, now) {
      return transaction(() => {
        prune(now);
        const record = find(hash, kind, now);
        if (record !== undefined)
          db.prepare("UPDATE grants SET lastSeenAt=? WHERE grantId=?").run(now, record.grantId);
        return record;
      });
    },
    restrictByAccessToken(hash, profile, now) {
      validateSurfaceProfile(profile);
      return transaction(() => {
        prune(now);
        const record = find(hash, "access", now);
        if (record === undefined) throw new Error("invalid_access_token");
        if (record.surfaceProfile === "gateway-only" && profile === "full")
          throw new Error("self_promotion_forbidden");
        db.prepare("UPDATE grants SET surfaceProfile=? WHERE grantId=?").run(
          profile,
          record.grantId
        );
        return {
          clientId: record.clientId,
          grantId: record.grantId,
          connectionId: record.connectionId,
          resource: record.resource,
          scopes: record.scopes,
          surfaceProfile: profile
        };
      });
    },
    listConnections(now) {
      return transaction(() => {
        prune(now);
        return db
          .prepare("SELECT * FROM grants ORDER BY createdAt, grantId")
          .all()
          .map(grantFromRow);
      });
    },
    getClientDefault: getDefault,
    setClientDefault(clientId, profile) {
      if (!idSchema.safeParse(clientId).success)
        throw new Error("oauth_grant_store_invalid_client");
      validateSurfaceProfile(profile);
      transaction(() => {
        if (
          getDefault(clientId) === undefined &&
          Number(db.prepare("SELECT count(*) AS n FROM client_defaults").get()?.n) >= maxDefaults
        ) {
          throw new Error("oauth_grant_store_capacity");
        }
        db.prepare(
          "INSERT INTO client_defaults VALUES(?,?) ON CONFLICT(clientId) DO UPDATE SET surfaceProfile=excluded.surfaceProfile"
        ).run(clientId, profile);
      });
    },
    setGrantProfile(grantId, profile, now) {
      validateSurfaceProfile(profile);
      transaction(() => {
        prune(now);
        if (
          db.prepare("UPDATE grants SET surfaceProfile=? WHERE grantId=?").run(profile, grantId)
            .changes === 0
        ) {
          throw new Error("oauth_grant_not_found");
        }
      });
    },
    setConnectionLabel(grantId, label, now) {
      const parsed = validateConnectionLabel(label);
      transaction(() => {
        prune(now);
        if (
          db.prepare("UPDATE grants SET label=? WHERE grantId=?").run(parsed, grantId).changes === 0
        ) {
          throw new Error("oauth_grant_not_found");
        }
      });
    },
    revokeGrant(grantId) {
      return db.prepare("DELETE FROM grants WHERE grantId=?").run(grantId).changes !== 0;
    },
    revokeClient(clientId) {
      transaction(() => {
        db.prepare("DELETE FROM grants WHERE clientId=?").run(clientId);
        db.prepare("DELETE FROM client_defaults WHERE clientId=?").run(clientId);
      });
    },
    revokeAll() {
      transaction(() => {
        db.exec("DELETE FROM grants; DELETE FROM client_defaults;");
      });
    },
    hasClient(clientId, now) {
      validTime(now);
      return (
        db
          .prepare(
            "SELECT 1 FROM grants g JOIN tokens t ON t.grantId=g.grantId WHERE g.clientId=? AND t.expiresAt>? LIMIT 1"
          )
          .get(clientId, now) !== undefined
      );
    },
    prune(now) {
      transaction(() => prune(now));
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    }
  };
}
