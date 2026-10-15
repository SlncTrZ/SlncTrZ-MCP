import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createDynamicClientFileStore } from "../../src/auth/dynamic-client-store.js";
import { createStaticClientRedirectStore } from "../../src/auth/static-client-redirect-store.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";

const roots: string[] = [];
const services: OAuthService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "slnctrz-client-reload-"));
  roots.push(root);
  const path = join(root, "clients.json");
  const dynamic = createDynamicClientFileStore(path, 4);
  const redirects = createStaticClientRedirectStore(join(root, "redirects.json"));
  const owner = "reload fixture owner";
  const oauth = new OAuthService({
    issuer: new URL("https://gateway.test"),
    resource: new URL("https://gateway.test/mcp"),
    ownerSecretHash: createOwnerSecretHash(owner),
    dynamicClientStore: dynamic,
    staticRedirectStore: redirects,
    maxDynamicClients: 4,
    staticClient: {
      clientId: "static",
      clientSecret: "static fixture",
      redirectUris: ["http://127.0.0.1/callback"]
    }
  });
  services.push(oauth);
  const begin = (clientId: string, redirect = "http://127.0.0.1/callback") =>
    oauth.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: oauth.pkceChallenge("v".repeat(43)),
      code_challenge_method: "S256",
      scope: "mcp:tools",
      resource: "https://gateway.test/mcp"
    });
  return { oauth, dynamic, redirects, path, owner, begin };
}

describe("Owner client registry hot reload", () => {
  it("adds external dynamic clients and persisted static callbacks without restart", () => {
    const f = fixture();
    f.dynamic.save([
      { clientId: "external", redirectUris: ["http://127.0.0.1/callback"], issuedAt: 100 }
    ]);
    expect(() => f.begin("external")).toThrow("Unknown client");
    f.redirects.add("static", "https://client.test/new", 101);
    expect(() => f.begin("static", "https://client.test/new")).toThrow("not registered");
    expect(f.oauth.reloadClientsByOwner()).toEqual({
      activated: true,
      dynamicClients: 1,
      staticRedirects: 2
    });
    expect(f.begin("external").transactionId).toBeTruthy();
    expect(f.begin("static", "https://client.test/new").transactionId).toBeTruthy();
  });

  it("keeps the prior live snapshot when a later candidate row or JSON is invalid", () => {
    const f = fixture();
    const existing = f.oauth.registerClient({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none"
    });
    const original = f.dynamic.load();
    f.dynamic.save([
      ...original,
      { clientId: "candidate", redirectUris: ["https://client.test/new"], issuedAt: 101 },
      { clientId: "bad", redirectUris: ["http://evil.test/callback"], issuedAt: 101 }
    ]);
    expect(() => f.oauth.reloadClientsByOwner()).toThrow();
    expect(() => f.begin("candidate", "https://client.test/new")).toThrow("Unknown client");
    expect(f.begin(existing.client_id).transactionId).toBeTruthy();
    writeFileSync(f.path, "invalid JSON", { mode: 0o600 });
    expect(() => f.oauth.reloadClientsByOwner()).toThrow("invalid_json");
    expect(f.begin(existing.client_id).transactionId).toBeTruthy();
  });

  it("rejects static collision and active-client deletion; normal Owner revoke precedes removal", () => {
    const f = fixture();
    f.dynamic.save([
      { clientId: "static", redirectUris: ["https://client.test/new"], issuedAt: 101 }
    ]);
    expect(() => f.oauth.reloadClientsByOwner()).toThrow("duplicate");
    const c = f.oauth.registerClient({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none"
    });
    f.begin(c.client_id);
    f.dynamic.save([]);
    expect(() => f.oauth.reloadClientsByOwner()).toThrow("requires_revoke");
    expect(f.begin(c.client_id).transactionId).toBeTruthy();
    expect(f.oauth.revokeClientByOwner(c.client_id)).toBe(true);
    expect(f.oauth.reloadClientsByOwner().dynamicClients).toBe(0);
    expect(() => f.begin(c.client_id)).toThrow("Unknown client");
  });

  it("preserves existing PKCE grants and their scope/profile during additions", async () => {
    const f = fixture();
    const c = f.oauth.registerClient({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none"
    });
    const pending = f.begin(c.client_id);
    const code = f.oauth.approveAuthorization(pending.transactionId, f.owner, "gateway-only");
    const tokens = f.oauth.exchangeAuthorizationCode({
      grant_type: "authorization_code",
      code: code.searchParams.get("code") ?? "",
      client_id: c.client_id,
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: "v".repeat(43),
      resource: "https://gateway.test/mcp"
    });
    f.dynamic.save([
      ...f.dynamic.load(),
      { clientId: "new", redirectUris: ["https://client.test/new"], issuedAt: 101 }
    ]);
    f.oauth.reloadClientsByOwner();
    expect(await f.oauth.authenticateConnection(tokens.access_token)).toMatchObject({
      surfaceProfile: "gateway-only",
      scopes: ["mcp:tools"]
    });
    const rotated = f.oauth.exchangeRefreshToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: c.client_id,
      resource: "https://gateway.test/mcp"
    });
    expect(await f.oauth.authenticateConnection(rotated.access_token)).toMatchObject({
      surfaceProfile: "gateway-only"
    });
  });
});
