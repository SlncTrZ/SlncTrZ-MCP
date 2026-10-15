import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { HostTokenStore, HOST_TOKEN_IDLE_SECONDS } from "../../src/auth/host-token-store.js";

const roots: string[] = [];
const stores: HostTokenStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slnctrz-host-store-"));
  roots.push(root);
  return { root, path: join(root, "hosts.sqlite3") };
}

describe("host token store", () => {
  it("issues hash-only credentials and authenticates without fixed expiry", () => {
    const store = new HostTokenStore(":memory:");
    const { token, metadata } = store.issue("Pi workstation", 100);
    expect(token).toMatch(/^hst_[A-Za-z0-9_-]{43}$/);
    expect(store.authenticate(token, 101)?.tokenId).toBe(metadata.tokenId);
    expect(store.authenticate(token, 101 + HOST_TOKEN_IDLE_SECONDS - 1)).toBeDefined();
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it("deletes credentials at 15 days but retains audit", () => {
    const store = new HostTokenStore(":memory:");
    const { token } = store.issue("Codex", 100);
    expect(store.authenticate("hst_" + "A".repeat(43), 200)).toBeUndefined();
    expect(store.authenticate(token, 100 + HOST_TOKEN_IDLE_SECONDS)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    expect(store.audit().map((entry) => entry.event)).toEqual(["issued", "inactive_15d"]);
    expect(store.authenticate(token, 100 + HOST_TOKEN_IDLE_SECONDS + 1)).toBeUndefined();
    store.close();
  });

  it("owner revoke deletes credential but retains audit", () => {
    const store = new HostTokenStore(":memory:");
    const { token, metadata } = store.issue("OpenCode", 100);
    expect(store.revoke(metadata.tokenId, 110)).toBe(true);
    expect(store.revoke(metadata.tokenId, 111)).toBe(false);
    expect(store.authenticate(token, 120)).toBeUndefined();
    expect(store.audit().at(-1)?.event).toBe("revoked");
    store.close();
  });

  it("prunes idle credentials independently of inbound requests", () => {
    const store = new HostTokenStore(":memory:");
    store.issue("Claude", 100);
    expect(store.prune(100 + HOST_TOKEN_IDLE_SECONDS - 1)).toBe(0);
    expect(store.prune(100 + HOST_TOKEN_IDLE_SECONDS)).toBe(1);
    expect(store.audit().at(-1)?.event).toBe("inactive_15d");
    store.close();
  });

  it.each([-1, 0, 1])("enforces unused and used inactivity boundary (%i seconds)", (offset) => {
    for (const used of [false, true]) {
      const store = new HostTokenStore(":memory:");
      stores.push(store);
      const issued = store.issue("boundary", 100);
      if (used) store.authenticate(issued.token, 200);
      const result = store.authenticate(
        issued.token,
        (used ? 200 : 100) + HOST_TOKEN_IDLE_SECONDS + offset
      );
      expect(result !== undefined).toBe(offset < 0);
      expect(store.list()).toHaveLength(offset < 0 ? 1 : 0);
      expect(store.audit().at(-1)?.event).toBe(offset < 0 ? "used" : "inactive_15d");
    }
  });

  it("active clients survive years; invalid credentials do not move the anchor", () => {
    const store = new HostTokenStore(":memory:");
    stores.push(store);
    const issued = store.issue("long lived", 100);
    let at = 100;
    for (let i = 0; i < 100; i++) {
      at += HOST_TOKEN_IDLE_SECONDS - 1;
      expect(store.authenticate(issued.token, at)).toBeDefined();
    }
    expect(store.authenticate(issued.token.slice(0, -1) + ".", at + 1)).toBeUndefined();
    expect(store.authenticate("hst_" + "A".repeat(43), at + 2)).toBeUndefined();
    expect(store.list()[0]?.lastUsedAt).toBe(at);
    expect(store.authenticate(issued.token, at + HOST_TOKEN_IDLE_SECONDS)).toBeUndefined();
  });

  it("persists metadata and audit after restart, downtime expiry, and revoke", () => {
    const { path } = fixture();
    let store = new HostTokenStore(path);
    const active = store.issue("active", 100);
    const unused = store.issue("unused", 100);
    store.authenticate(active.token, 200);
    store.close();
    store = new HostTokenStore(path);
    expect(store.authenticate(unused.token, 100 + HOST_TOKEN_IDLE_SECONDS)).toBeUndefined();
    expect(store.authenticate(active.token, 100 + HOST_TOKEN_IDLE_SECONDS)).toBeDefined();
    expect(store.revoke(active.metadata.tokenId, 200 + HOST_TOKEN_IDLE_SECONDS)).toBe(true);
    store.close();
    store = new HostTokenStore(path);
    stores.push(store);
    expect(store.list()).toEqual([]);
    expect(store.authenticate(active.token, 201 + HOST_TOKEN_IDLE_SECONDS)).toBeUndefined();
    expect(store.audit().map((e) => e.event)).toEqual([
      "issued",
      "issued",
      "used",
      "inactive_15d",
      "used",
      "revoked"
    ]);
  });

  it("stores only hashes and bounded separate audit; keeps the SQLite version unchanged", () => {
    const { path } = fixture();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=3");
    db.close();
    const store = new HostTokenStore(path, { maxAuditRows: 3 });
    const issued = store.issue("private", 100);
    for (let at = 101; at < 106; at++) store.authenticate(issued.token, at);
    expect(store.audit()).toHaveLength(3);
    expect(store.revoke(issued.metadata.tokenId, 106)).toBe(true);
    expect(store.audit().at(-1)?.event).toBe("revoked");
    store.close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    expect(raw.prepare("SELECT count(*) n FROM host_tokens").get()).toMatchObject({ n: 0 });
    const columns = raw
      .prepare("PRAGMA table_info(host_token_audit)")
      .all()
      .map((r) => r.name);
    expect(columns).not.toContain("tokenHash");
    const audit = JSON.stringify(raw.prepare("SELECT * FROM host_token_audit").all());
    expect(audit).not.toContain(issued.token);
    expect(audit).not.toContain(createHash("sha256").update(issued.token).digest("hex"));
    raw.close();
    expect(readFileSync(path).includes(Buffer.from(issued.token))).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("serializes independent connections: revoke/prune commits cannot be undone by auth", () => {
    const { path } = fixture();
    const a = new HostTokenStore(path),
      b = new HostTokenStore(path);
    stores.push(a, b);
    const first = a.issue("revoke", 100);
    expect(b.authenticate(first.token, 101)).toBeDefined();
    expect(a.revoke(first.metadata.tokenId, 102)).toBe(true);
    expect(b.authenticate(first.token, 103)).toBeUndefined();
    const second = b.issue("cleanup", 100);
    expect(a.prune(100 + HOST_TOKEN_IDLE_SECONDS)).toBe(1);
    expect(b.authenticate(second.token, 100 + HOST_TOKEN_IDLE_SECONDS)).toBeUndefined();
    expect(
      b
        .audit()
        .filter((e) => e.tokenId === second.metadata.tokenId)
        .map((e) => e.event)
    ).toEqual(["issued", "inactive_15d"]);
  });

  it("does not regress lastUsedAt on clock rollback and rejects invalid timestamps", () => {
    const store = new HostTokenStore(":memory:");
    stores.push(store);
    const issued = store.issue("clock", 100);
    store.authenticate(issued.token, 200);
    expect(store.authenticate(issued.token, 150)?.lastUsedAt).toBe(200);
    expect(() => store.revoke(issued.metadata.tokenId, NaN)).toThrow("invalid_host_token_time");
    expect(() => store.prune(-1)).toThrow("invalid_host_token_time");
  });

  it("rejects capacity without evicting active credentials", () => {
    const store = new HostTokenStore(":memory:");
    stores.push(store);
    for (let i = 0; i < 64; i++) store.issue("client", 100);
    expect(() => store.issue("overflow", 101)).toThrow("host_token_capacity");
    expect(store.list()).toHaveLength(64);
    expect(store.audit()).toHaveLength(64);
  });

  it.skipIf(process.platform === "win32")(
    "rejects DB, WAL and directory symlinks without touching targets",
    () => {
      const { root, path } = fixture();
      const target = join(root, "target");
      writeFileSync(target, "untouched");
      for (const suffix of ["", "-wal", "-shm"]) {
        symlinkSync(target, path + suffix);
        expect(() => new HostTokenStore(path)).toThrow("invalid_host_token_path");
        expect(readFileSync(target, "utf8")).toBe("untouched");
        rmSync(path + suffix);
      }
      const directory = join(root, "linked");
      symlinkSync(root, directory, "dir");
      expect(() => new HostTokenStore(join(directory, "new.sqlite3"))).toThrow(
        "invalid_host_token_path"
      );
    }
  );
});
