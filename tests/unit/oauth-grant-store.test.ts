import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  existsSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteOAuthGrantStore } from "../../src/auth/oauth-grant-store.js";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createDynamicClientFileStore } from "../../src/auth/dynamic-client-store.js";
import { OwnerConnectionService } from "../../src/auth/owner-connection-service.js";
import {
  isToolVisibleForProfile,
  resolveSurfaceProfile
} from "../../src/auth/connection-profile.js";

const OWNER = "test-owner-password";
const HASH = createOwnerSecretHash(OWNER);
const RESOURCE = new URL("https://mcp.example.com/mcp");
const REDIRECT = "https://client.example.com/callback";
const directories: string[] = [];
const stores: ReturnType<typeof createSqliteOAuthGrantStore>[] = [];
function fixture(options: { maxTokens?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "oauth-grants-"));
  directories.push(directory);
  const path = join(directory, "oauth-grants.sqlite3");
  let now = 1000;
  const open = () => {
    const store = createSqliteOAuthGrantStore(path, options);
    stores.push(store);
    const service = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: RESOURCE,
      ownerSecretHash: HASH,
      now: () => now,
      grantStore: store,
      dynamicClientStore: createDynamicClientFileStore(join(directory, "oauth-clients.json"), 10)
    });
    const owner = new OwnerConnectionService(store, () => now);
    return { store, service, owner };
  };
  return {
    ...open(),
    open,
    directory,
    path,
    advance: (seconds: number) => {
      now += seconds;
    }
  };
}
function register(service: OAuthService) {
  return service.registerClient({ redirect_uris: [REDIRECT] }).client_id;
}
function issue(service: OAuthService, clientId: string) {
  const verifier = "a".repeat(43);
  const pending = service.beginAuthorization({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: service.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE.href
  });
  const redirect = service.approveAuthorization(pending.transactionId, OWNER);
  return service.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: RESOURCE.href,
    code_verifier: verifier
  });
}
function refresh(service: OAuthService, clientId: string, token: string) {
  return service.exchangeRefreshToken({
    grant_type: "refresh_token",
    client_id: clientId,
    resource: RESOURCE.href,
    refresh_token: token
  });
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("durable OAuth grants and profiles", () => {
  it("retains access, refresh, identity and profile across reopen without plaintext persistence", async () => {
    const f = fixture();
    const clientId = register(f.service);
    const token = issue(f.service, clientId);
    const identity = await f.service.authenticateConnection(token.access_token);
    expect(identity).toMatchObject({ clientId, surfaceProfile: "full", scopes: ["mcp:tools"] });
    expect(identity.connectionId).toBe(identity.grantId);
    f.service.restrictConnection(token.access_token, "gateway-only");
    for (const name of readdirSync(f.directory).filter((name) => name.startsWith("oauth-grants"))) {
      const bytes = readFileSync(join(f.directory, name));
      expect(bytes.includes(Buffer.from(token.access_token))).toBe(false);
      expect(bytes.includes(Buffer.from(token.refresh_token))).toBe(false);
      if (process.platform !== "win32")
        expect(statSync(join(f.directory, name)).mode & 0o077).toBe(0);
    }
    f.store.close();
    const reopened = f.open();
    expect(await reopened.service.verifyAccessToken(token.access_token)).toMatchObject({
      clientId
    });
    expect(await reopened.service.authenticateConnection(token.access_token)).toMatchObject({
      grantId: identity.grantId,
      surfaceProfile: "gateway-only"
    });
    const rotated = refresh(reopened.service, clientId, token.refresh_token);
    expect(await reopened.service.authenticateConnection(rotated.access_token)).toMatchObject({
      grantId: identity.grantId,
      surfaceProfile: "gateway-only"
    });
    expect(() => refresh(reopened.service, clientId, token.refresh_token)).toThrow();
    expect(await reopened.service.verifyAccessToken(token.access_token)).toMatchObject({
      clientId
    });
  });

  it("isolates grants of one client, snapshots future defaults, and forbids self promotion", async () => {
    const f = fixture();
    const client = register(f.service);
    const first = issue(f.service, client);
    f.owner.setClientDefault(client, "gateway-only");
    const second = issue(f.service, client);
    const a = await f.service.authenticateConnection(first.access_token);
    const b = await f.service.authenticateConnection(second.access_token);
    expect(a.grantId).not.toBe(b.grantId);
    expect(a.surfaceProfile).toBe("full");
    expect(b.surfaceProfile).toBe("gateway-only");
    f.owner.setClientDefault(client, "full");
    expect((await f.service.authenticateConnection(second.access_token)).surfaceProfile).toBe(
      "gateway-only"
    );
    expect(() => f.service.restrictConnection(second.access_token, "full")).toThrow(
      "self_promotion"
    );
    f.service.restrictConnection(first.access_token, "gateway-only");
    f.owner.setGrantProfile(a.grantId, "full");
    expect((await f.service.authenticateConnection(first.access_token)).surfaceProfile).toBe(
      "full"
    );
    expect((await f.service.authenticateConnection(second.access_token)).surfaceProfile).toBe(
      "gateway-only"
    );
    expect(() => f.owner.setGrantProfile("unknown", "full")).toThrow();
    expect(() => f.owner.setGrantProfile(a.grantId, "invalid" as "full")).toThrow();
    expect(JSON.stringify(f.owner.listConnections())).not.toContain(first.access_token);
    expect(JSON.stringify(f.owner.listConnections())).not.toContain("tokenHash");
    expect(f.owner.listConnections()).toHaveLength(2);
  });

  it("rechecks profile from a second handle and only one refresh consumes a credential", async () => {
    const f = fixture();
    const client = register(f.service);
    const token = issue(f.service, client);
    const other = f.open();
    const identity = await f.service.authenticateConnection(token.access_token);
    other.owner.setGrantProfile(identity.grantId, "gateway-only");
    expect((await f.service.authenticateConnection(token.access_token)).surfaceProfile).toBe(
      "gateway-only"
    );
    const next = refresh(other.service, client, token.refresh_token);
    expect(() => refresh(f.service, client, token.refresh_token)).toThrow();
    expect(await f.service.authenticateConnection(next.access_token)).toMatchObject({
      grantId: identity.grantId
    });
  });

  it("revokes a whole grant by token, respects client binding, and leaves sibling grants usable", async () => {
    const f = fixture();
    const client = register(f.service);
    const other = register(f.service);
    const a = issue(f.service, client);
    const b = issue(f.service, client);
    f.service.revokeToken({ client_id: other, token: a.access_token });
    expect(await f.service.verifyAccessToken(a.access_token)).toBeDefined();
    const next = refresh(f.service, client, a.refresh_token);
    f.service.revokeToken({
      client_id: client,
      token: a.access_token,
      token_type_hint: "refresh_token"
    });
    await expect(f.service.verifyAccessToken(next.access_token)).rejects.toThrow();
    expect(() => refresh(f.service, client, next.refresh_token)).toThrow();
    expect(await f.service.verifyAccessToken(b.access_token)).toBeDefined();
    f.store.close();
    const reopened = f.open();
    await expect(reopened.service.verifyAccessToken(a.access_token)).rejects.toThrow();
    expect(reopened.service.revokeTokenByOwner(b.refresh_token)).toBe(true);
    expect(reopened.owner.listConnections()).toHaveLength(0);
  });

  it("owner grant/client/all revocation survives reopen", async () => {
    const f = fixture();
    const client = register(f.service);
    const other = register(f.service);
    const a = issue(f.service, client);
    const b = issue(f.service, other);
    const aId = (await f.service.authenticateConnection(a.access_token)).grantId;
    expect(f.owner.revokeGrant(aId)).toBe(true);
    expect(f.service.revokeClientByOwner(other)).toBe(true);
    f.store.close();
    const reopened = f.open();
    await expect(reopened.service.verifyAccessToken(a.access_token)).rejects.toThrow();
    await expect(reopened.service.verifyAccessToken(b.access_token)).rejects.toThrow();
    const c = issue(reopened.service, client);
    expect(reopened.service.revokeAllByOwner()).toEqual({ clients: 1, grants: 1 });
    await expect(reopened.service.verifyAccessToken(c.access_token)).rejects.toThrow();
  });

  it("expires at exact boundaries and prunes expired tokens and orphaned grants", async () => {
    const f = fixture();
    const client = register(f.service);
    const token = issue(f.service, client);
    f.advance(900);
    await expect(f.service.verifyAccessToken(token.access_token)).rejects.toThrow();
    expect(f.owner.listConnections()).toHaveLength(1);
    f.advance(30 * 24 * 60 * 60 - 900);
    expect(() => refresh(f.service, client, token.refresh_token)).toThrow();
    expect(f.owner.listConnections()).toHaveLength(0);
    const db = new DatabaseSync(f.path);
    expect(db.prepare("SELECT count(*) AS n FROM tokens").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM grants").get()?.n).toBe(0);
    db.close();
  });

  it("bounds storage without revoking valid grants and rolls back failed refresh", async () => {
    const f = fixture({ maxTokens: 2 });
    const client = register(f.service);
    const token = issue(f.service, client);
    expect(() => refresh(f.service, client, token.refresh_token)).toThrow("capacity");
    expect(await f.service.verifyAccessToken(token.access_token)).toBeDefined();
    expect(() => issue(f.service, client)).toThrow("capacity");
    f.advance(900);
    expect(refresh(f.service, client, token.refresh_token).access_token).toBeTruthy();
    expect(f.owner.listConnections()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "rejects dangling database and sidecar symlinks without creating their targets",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "oauth-symlink-"));
      directories.push(directory);
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = join(directory, "link-" + (suffix || "db") + ".sqlite3");
        const target = join(directory, "target-" + (suffix || "db"));
        symlinkSync(target, path + suffix);
        expect(() => createSqliteOAuthGrantStore(path)).toThrow("oauth_grant_store_invalid_path");
        expect(existsSync(target)).toBe(false);
      }
    }
  );

  it("persists future defaults and intersects a new grant request with the owner ceiling", () => {
    const f = fixture();
    const client = register(f.service);
    f.owner.setClientDefault(client, "gateway-only");
    f.store.close();
    const reopened = f.open();
    expect(reopened.owner.getClientDefault(client)).toBe("gateway-only");
    reopened.store.issue(
      {
        grantId: "request-full",
        clientId: client,
        resource: RESOURCE.href,
        scopes: ["mcp:tools"],
        requestedProfile: "full"
      },
      [
        { tokenHash: "a".repeat(64), kind: "access", expiresAt: 2000 },
        { tokenHash: "b".repeat(64), kind: "refresh", expiresAt: 3000 }
      ],
      1000
    );
    expect(reopened.owner.listConnections()[0]?.surfaceProfile).toBe("gateway-only");
    reopened.owner.setClientDefault(client, "full");
    reopened.store.issue(
      {
        grantId: "request-restricted",
        clientId: client,
        resource: RESOURCE.href,
        scopes: ["mcp:tools"],
        requestedProfile: "gateway-only"
      },
      [
        { tokenHash: "c".repeat(64), kind: "access", expiresAt: 2000 },
        { tokenHash: "d".repeat(64), kind: "refresh", expiresAt: 3000 }
      ],
      1000
    );
    expect(reopened.owner.listConnections().every((c) => c.surfaceProfile === "gateway-only")).toBe(
      true
    );
  });

  it("requires a valid access bearer for restriction and does not enrich SDK AuthInfo", async () => {
    const f = fixture();
    const client = register(f.service);
    const token = issue(f.service, client);
    expect(() => f.service.restrictConnection(token.refresh_token, "gateway-only")).toThrow();
    const sdk = await f.service.verifyAccessToken(token.access_token);
    expect(sdk).not.toHaveProperty("surfaceProfile");
    expect(sdk).not.toHaveProperty("grantId");
    f.advance(900);
    expect(() => f.service.restrictConnection(token.access_token, "gateway-only")).toThrow();
  });

  it("fails closed for corrupt or unsupported database schemas", () => {
    const directory = mkdtempSync(join(tmpdir(), "oauth-invalid-"));
    directories.push(directory);
    const path = join(directory, "bad.sqlite3");
    writeFileSync(path, "not a database", { mode: 0o600 });
    expect(() => createSqliteOAuthGrantStore(path)).toThrow("oauth_grant_store");
    rmSync(path);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=999");
    db.close();
    expect(() => createSqliteOAuthGrantStore(path)).toThrow("oauth_grant_store");
  });
});

describe("surface foundation", () => {
  it("resolves overrides, future defaults, and compatibility full without widening", () => {
    expect(resolveSurfaceProfile()).toBe("full");
    expect(resolveSurfaceProfile(undefined, "gateway-only")).toBe("gateway-only");
    expect(resolveSurfaceProfile("full", "gateway-only")).toBe("full");
    expect(() => resolveSurfaceProfile("unknown" as "full")).toThrow();
  });
  it("requires explicit provider classification and blocks hidden builtins", () => {
    for (const name of [
      "core.read",
      "core.exec",
      "context.bootstrap",
      "skills.read",
      "task.start",
      "media.read_image"
    ]) {
      expect(isToolVisibleForProfile("gateway-only", { name, source: "builtin" })).toBe(false);
      expect(isToolVisibleForProfile("full", { name, source: "builtin" })).toBe(true);
    }
    for (const name of [
      "core.ping",
      "debate.create",
      "debate.join",
      "debate.read",
      "debate.send",
      "debate.wait",
      "debate.stop"
    ]) {
      expect(isToolVisibleForProfile("gateway-only", { name, source: "builtin" })).toBe(true);
    }
    expect(isToolVisibleForProfile("gateway-only", { name: "kb.search", source: "provider" })).toBe(
      true
    );
    expect(
      isToolVisibleForProfile("gateway-only", { name: "unknown.tool", source: "builtin" })
    ).toBe(false);
    expect(
      isToolVisibleForProfile("gateway-only", { name: "debate.admin", source: "builtin" })
    ).toBe(false);
    expect(() =>
      isToolVisibleForProfile("bad" as "full", { name: "core.ping", source: "builtin" })
    ).toThrow();
  });
});
