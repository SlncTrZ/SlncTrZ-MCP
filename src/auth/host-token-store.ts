/** Owner-issued non-interactive bearer credentials; additive SQLite v3 companion store. */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, chmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_PERSISTED_AUDIT_ROWS } from "../observability/sqlite-audit.js";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";

export const HOST_TOKEN_IDLE_SECONDS = 15 * 24 * 60 * 60;
const MAX_HOST_TOKENS = 64;

export interface HostTokenMetadata {
  readonly tokenId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface HostTokenIssue {
  readonly token: string;
  readonly metadata: HostTokenMetadata;
}

export class HostTokenStore {
  readonly #db: DatabaseSync;
  readonly #maxAuditRows: number;
  #closed = false;
  constructor(path: string, options: { maxAuditRows?: number } = {}) {
    this.#maxAuditRows = options.maxAuditRows ?? DEFAULT_MAX_PERSISTED_AUDIT_ROWS;
    if (!Number.isSafeInteger(this.#maxAuditRows) || this.#maxAuditRows < 1)
      throw new Error("invalid_host_token_audit_limit");
    if (path !== ":memory:") {
      const directory = dirname(path);
      const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
      if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()))
        throw new Error("invalid_host_token_path");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      ensureWindowsPrivateAcl(directory, "directory");
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      for (const candidate of [path, path + "-wal", path + "-shm"]) {
        const stat = lstatSync(candidate, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_host_token_path");
        if (process.platform !== "win32") chmodSync(candidate, 0o600);
        ensureWindowsPrivateAcl(candidate, "file");
      }
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS host_tokens (
        tokenHash TEXT PRIMARY KEY CHECK(length(tokenHash)=64),
        tokenId TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastUsedAt INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_token_audit (
        eventId INTEGER PRIMARY KEY, tokenId TEXT NOT NULL, event TEXT NOT NULL,
        actor TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;`);
    if (path !== ":memory:") {
      for (const candidate of [path, path + "-wal", path + "-shm"]) {
        const stat = lstatSync(candidate, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_host_token_path");
        if (process.platform !== "win32") chmodSync(candidate, 0o600);
        ensureWindowsPrivateAcl(candidate, "file");
      }
    }
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #audit(tokenId: string, event: string, actor: string, now: number): void {
    this.#db
      .prepare("INSERT INTO host_token_audit(tokenId,event,actor,at) VALUES(?,?,?,?)")
      .run(tokenId, event, actor, now);
    this.#db
      .prepare(
        `DELETE FROM host_token_audit WHERE eventId <= COALESCE(
      (SELECT eventId FROM host_token_audit ORDER BY eventId DESC LIMIT 1 OFFSET ?), 0
    )`
      )
      .run(this.#maxAuditRows);
  }

  issue(label: string, now: number = Math.floor(Date.now() / 1000)): HostTokenIssue {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_host_token_time");
    const clean = label.trim();
    if (clean.length < 1 || clean.length > 64) throw new Error("invalid_host_token_label");
    const token = "hst_" + randomBytes(32).toString("base64url");
    const tokenId = randomBytes(12).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return this.#transaction(() => {
      const count = this.#db.prepare("SELECT count(*) AS n FROM host_tokens").get() as {
        n: number;
      };
      if (count.n >= MAX_HOST_TOKENS) throw new Error("host_token_capacity");
      this.#db
        .prepare(
          "INSERT INTO host_tokens(tokenHash,tokenId,label,createdAt,lastUsedAt) VALUES(?,?,?,?,NULL)"
        )
        .run(tokenHash, tokenId, clean, now);
      this.#audit(tokenId, "issued", "owner", now);
      return { token, metadata: { tokenId, label: clean, createdAt: now, lastUsedAt: null } };
    });
  }

  authenticate(
    token: string,
    now: number = Math.floor(Date.now() / 1000)
  ): HostTokenMetadata | undefined {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_host_token_time");
    if (!/^hst_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          "SELECT tokenHash,tokenId,label,createdAt,lastUsedAt FROM host_tokens WHERE tokenHash=?"
        )
        .get(tokenHash) as (HostTokenMetadata & { tokenHash: string }) | undefined;
      if (!row) return undefined;
      if (!timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(tokenHash, "hex")))
        return undefined;
      if (now - (row.lastUsedAt ?? row.createdAt) >= HOST_TOKEN_IDLE_SECONDS) {
        this.#db.prepare("DELETE FROM host_tokens WHERE tokenHash=?").run(tokenHash);
        this.#audit(row.tokenId, "inactive_15d", "system", now);
        return undefined;
      }
      // Wall-clock rollback must not move the idle anchor backwards.
      const lastUsedAt = Math.max(now, row.lastUsedAt ?? row.createdAt);
      this.#db
        .prepare("UPDATE host_tokens SET lastUsedAt=? WHERE tokenHash=?")
        .run(lastUsedAt, tokenHash);
      this.#audit(row.tokenId, "used", "host", now);
      return { tokenId: row.tokenId, label: row.label, createdAt: row.createdAt, lastUsedAt };
    });
  }

  revoke(tokenId: string, now: number = Math.floor(Date.now() / 1000)): boolean {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_host_token_time");
    return this.#transaction(() => {
      const removed = this.#db.prepare("DELETE FROM host_tokens WHERE tokenId=?").run(tokenId);
      if (!removed.changes) return false;
      this.#audit(tokenId, "revoked", "owner", now);
      return true;
    });
  }

  prune(now: number = Math.floor(Date.now() / 1000)): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_host_token_time");
    return this.#transaction(() => {
      const expired = this.#db
        .prepare("SELECT tokenId FROM host_tokens WHERE ? - COALESCE(lastUsedAt,createdAt) >= ?")
        .all(now, HOST_TOKEN_IDLE_SECONDS) as { tokenId: string }[];
      for (const row of expired) {
        this.#db.prepare("DELETE FROM host_tokens WHERE tokenId=?").run(row.tokenId);
        this.#audit(row.tokenId, "inactive_15d", "system", now);
      }
      return expired.length;
    });
  }

  list(): HostTokenMetadata[] {
    return this.#db
      .prepare(
        "SELECT tokenId,label,createdAt,lastUsedAt FROM host_tokens ORDER BY createdAt,tokenId"
      )
      .all() as unknown as HostTokenMetadata[];
  }

  audit(): { tokenId: string; event: string; actor: string; at: number }[] {
    return this.#db
      .prepare("SELECT tokenId,event,actor,at FROM host_token_audit ORDER BY eventId")
      .all() as { tokenId: string; event: string; actor: string; at: number }[];
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
