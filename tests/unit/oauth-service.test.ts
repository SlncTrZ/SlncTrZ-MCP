import { describe, expect, it } from "vitest";
import { OAuthError } from "@modelcontextprotocol/server";
import { type AuthAuditEvent } from "../../src/observability/auth-audit.js";
import { OAuthService, type OAuthServiceOptions } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";

const OWNER_SECRET = "correct horse battery staple";
const RESOURCE = new URL("https://mcp.example.com/mcp");

function createService(): OAuthService {
  const options: OAuthServiceOptions = {
    issuer: new URL("https://mcp.example.com"),
    resource: RESOURCE,
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET)
  };
  return new OAuthService(options);
}

function registerTestClient(service: OAuthService): string {
  return service.registerClient({
    client_name: "Test MCP Client",
    redirect_uris: ["https://client.example.com/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  }).client_id;
}

describe("OAuthService", () => {
  it("publishes OAuth and protected-resource discovery metadata", () => {
    const service = createService();

    expect(service.authorizationServerMetadata()).toMatchObject({
      issuer: "https://mcp.example.com/",
      authorization_endpoint: "https://mcp.example.com/authorize",
      token_endpoint: "https://mcp.example.com/token",
      registration_endpoint: "https://mcp.example.com/register",
      revocation_endpoint: "https://mcp.example.com/revoke",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"]
    });
    expect(service.protectedResourceMetadata()).toMatchObject({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://mcp.example.com/"],
      bearer_methods_supported: ["header"]
    });
  });

  it("registers only public authorization-code clients with safe redirects", () => {
    const service = createService();
    const registered = service.registerClient({
      client_name: "Test MCP Client",
      redirect_uris: ["https://client.example.com/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });

    expect(registered.client_id).toMatch(/^client_/);
    expect(registered.client_secret).toBeUndefined();

    expect(() =>
      service.registerClient({
        redirect_uris: ["http://attacker.example/callback"],
        token_endpoint_auth_method: "none"
      })
    ).toThrowError("redirect URI");
  });

  it("bounds dynamic registration by evicting only inactive clients", () => {
    const events: AuthAuditEvent[] = [];
    const service = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: RESOURCE,
      ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
      maxDynamicClients: 2,
      audit: (event) => events.push(event)
    });
    const firstClientId = registerTestClient(service);
    const firstPending = service.beginAuthorization({
      response_type: "code",
      client_id: firstClientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge("m".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    const inactiveClientId = registerTestClient(service);
    const replacementClientId = registerTestClient(service);

    expect(service.authorizationDetails(firstPending.transactionId).transactionId).toBe(
      firstPending.transactionId
    );
    expect(() =>
      service.beginAuthorization({
        response_type: "code",
        client_id: inactiveClientId,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_challenge: service.pkceChallenge("n".repeat(43)),
        code_challenge_method: "S256",
        resource: RESOURCE.href,
        scope: "mcp:tools"
      })
    ).toThrowError("Unknown client");
    expect(replacementClientId).toMatch(/^client_/u);
    service.beginAuthorization({
      response_type: "code",
      client_id: replacementClientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge("p".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    expect(() => registerTestClient(service)).toThrowError(
      "Dynamic client capacity is temporarily exhausted"
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "client.evicted",
        outcome: "success",
        clientId: inactiveClientId
      })
    );
  });

  it("enforces PKCE S256 and binds code, client, redirect, and resource", () => {
    const service = createService();
    const clientId = registerTestClient(service);
    const verifier = "a".repeat(43);
    const challenge = service.pkceChallenge(verifier);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools",
      state: "client-state"
    });

    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe("https://mcp.example.com/");

    const code = redirect.searchParams.get("code");
    expect(code).not.toBeNull();
    const tokens = service.exchangeAuthorizationCode({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_verifier: verifier,
      resource: RESOURCE.href
    });

    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("mcp:tools");
    expect(tokens.access_token).not.toContain(clientId);

    expect(() =>
      service.exchangeAuthorizationCode({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: clientId,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_verifier: verifier,
        resource: RESOURCE.href
      })
    ).toThrowError(OAuthError);
  });

  it("rejects a wrong owner secret and a wrong PKCE verifier", () => {
    const service = createService();
    const clientId = registerTestClient(service);
    const verifier = "b".repeat(43);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });

    expect(() => service.approveAuthorization(pending.transactionId, "wrong secret")).toThrowError(
      "Owner authentication failed"
    );

    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    expect(() =>
      service.exchangeAuthorizationCode({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code") ?? "",
        client_id: clientId,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_verifier: "c".repeat(43),
        resource: RESOURCE.href
      })
    ).toThrowError(OAuthError);
  });

  it("authenticates a static confidential client without consuming code on auth failure", () => {
    const clientId = "claude-static-client";
    const clientSecret = "server-side-client-secret";
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const service = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: RESOURCE,
      ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
      staticClient: {
        clientId,
        clientSecret,
        clientName: "Claude",
        redirectUris: [redirectUri]
      }
    });
    const verifier = "s".repeat(43);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    const parameters = {
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: RESOURCE.href
    };

    expect(() => service.exchangeAuthorizationCode(parameters)).toThrowError(
      "client_secret is required"
    );
    expect(
      service.exchangeAuthorizationCode({
        ...parameters,
        client_secret: clientSecret
      }).token_type
    ).toBe("Bearer");
  });

  it("revokes only the authenticated client's complete token family and audits without secrets", async () => {
    const events: AuthAuditEvent[] = [];
    const service = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: RESOURCE,
      ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
      audit: (event) => events.push(event)
    });
    const clientId = registerTestClient(service);
    const otherClientId = service.registerClient({
      redirect_uris: ["https://other.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    }).client_id;
    const verifier = "q".repeat(43);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    const issued = service.exchangeAuthorizationCode({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_verifier: verifier,
      resource: RESOURCE.href
    });

    service.revokeToken({
      token: issued.refresh_token,
      token_type_hint: "refresh_token",
      client_id: otherClientId
    });
    await expect(service.verifyAccessToken(issued.access_token)).resolves.toMatchObject({
      clientId
    });

    service.revokeToken({
      token: issued.refresh_token,
      token_type_hint: "refresh_token",
      client_id: clientId
    });

    await expect(service.verifyAccessToken(issued.access_token)).rejects.toThrowError(
      "Invalid or expired access token"
    );
    expect(() =>
      service.exchangeRefreshToken({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: clientId,
        resource: RESOURCE.href
      })
    ).toThrowError("Invalid refresh token");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(issued.access_token);
    expect(serialized).not.toContain(issued.refresh_token);
    expect(serialized).not.toContain(OWNER_SECRET);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "token.revoked",
        outcome: "success",
        clientId
      })
    );
  });

  it("verifies audience, expiry, scope, and rotates refresh tokens", async () => {
    const service = createService();
    const clientId = registerTestClient(service);
    const verifier = "d".repeat(43);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    const issued = service.exchangeAuthorizationCode({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_verifier: verifier,
      resource: RESOURCE.href
    });

    const auth = await service.verifyAccessToken(issued.access_token);
    expect(auth.clientId).toBe(clientId);
    expect(auth.scopes).toEqual(["mcp:tools"]);
    expect(auth.resource?.href).toBe(RESOURCE.href);

    const refreshed = service.exchangeRefreshToken({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: clientId,
      resource: RESOURCE.href
    });
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);

    expect(() =>
      service.exchangeRefreshToken({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: clientId,
        resource: RESOURCE.href
      })
    ).toThrowError(OAuthError);
  });

  it("supports owner-authorized grant and client revocation without returning token data", async () => {
    const service = createService();
    const clientId = registerTestClient(service);
    const verifier = "z".repeat(43);
    const pending = service.beginAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE.href,
      scope: "mcp:tools"
    });
    const redirect = service.approveAuthorization(pending.transactionId, OWNER_SECRET);
    const issued = service.exchangeAuthorizationCode({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_verifier: verifier,
      resource: RESOURCE.href
    });

    expect(service.revokeTokenByOwner(issued.refresh_token)).toBe(true);
    expect(service.revokeTokenByOwner(issued.refresh_token)).toBe(false);
    await expect(service.verifyAccessToken(issued.access_token)).rejects.toThrow(
      "Invalid or expired access token"
    );

    expect(service.revokeClientByOwner(clientId)).toBe(true);
    expect(service.revokeClientByOwner(clientId)).toBe(false);
    expect(() =>
      service.beginAuthorization({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_challenge: service.pkceChallenge("y".repeat(43)),
        code_challenge_method: "S256",
        resource: RESOURCE.href,
        scope: "mcp:tools"
      })
    ).toThrow("Unknown client");
  });
});
