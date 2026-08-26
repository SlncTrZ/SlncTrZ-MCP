import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { type AuthAuditEvent, type AuthAuditSink } from "../../src/observability/auth-audit.js";
import { OAuthService, type OAuthServiceOptions } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";

const OWNER_SECRET = "correct horse battery staple";
const RESOURCE = "https://mcp.example.com/mcp";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        })
    )
  );
});

async function startOAuthServer(
  staticClient?: OAuthServiceOptions["staticClient"],
  audit?: AuthAuditSink
): Promise<{
  readonly origin: string;
  readonly service: OAuthService;
}> {
  const service = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
    ...(staticClient === undefined ? {} : { staticClient }),
    ...(audit === undefined ? {} : { audit })
  });
  const server = createGatewayServer({ oauthService: service });
  servers.push(server);
  const address = await listenGateway(server, {
    host: "127.0.0.1",
    port: 0
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    service
  };
}

function transactionFromHtml(html: string): string {
  const match = html.match(/name="transaction_id" value="([^"]+)"/u);
  if (match?.[1] === undefined) throw new Error("Missing authorization transaction");
  return match[1];
}

describe("OAuth HTTP flow", () => {
  it("serves authorization and protected-resource discovery", async () => {
    const { origin } = await startOAuthServer();

    const authorization = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);

    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      issuer: "https://mcp.example.com/",
      authorization_endpoint: "https://mcp.example.com/authorize",
      token_endpoint: "https://mcp.example.com/token",
      registration_endpoint: "https://mcp.example.com/register",
      revocation_endpoint: "https://mcp.example.com/revoke"
    });
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://mcp.example.com/"]
    });
  });

  it("allows the validated OAuth callback origin through consent-page CSP", async () => {
    const { origin, service } = await startOAuthServer();
    const redirectUri = "https://client.example.com/oauth/callback";
    const registered = service.registerClient({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none"
    });
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge("c".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();

    const response = await fetch(authorizeUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://client.example.com"
    );
  });

  it("exchanges a static confidential-client code with HTTP Basic authentication", async () => {
    const clientId = "claude-static-client";
    const clientSecret = "server-side-client-secret";
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const { origin, service } = await startOAuthServer({
      clientId,
      clientSecret,
      clientName: "Claude",
      redirectUris: [redirectUri]
    });
    const verifier = "h".repeat(43);
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools",
      state: "claude-state"
    }).toString();

    const page = await fetch(authorizeUrl);
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://claude.ai"
    );
    const transactionId = transactionFromHtml(await page.text());
    const approval = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        owner_secret: OWNER_SECRET,
        decision: "approve"
      }),
      redirect: "manual"
    });
    expect(approval.status).toBe(303);
    const callback = new URL(approval.headers.get("location") ?? "");

    const token = await fetch(`${origin}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE
      })
    });

    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({
      token_type: "Bearer",
      resource: RESOURCE
    });
  });

  it("completes DCR, owner authorization, PKCE exchange, and MCP Bearer auth", async () => {
    const { origin, service } = await startOAuthServer();
    const redirectUri = "https://client.example.com/oauth/callback";

    const registration = await fetch(`${origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "HTTP Flow Test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = "v".repeat(43);
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools",
      state: "http-state"
    }).toString();

    const authorizationPage = await fetch(authorizeUrl);
    expect(authorizationPage.status).toBe(200);
    const transactionId = transactionFromHtml(await authorizationPage.text());

    const approval = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        owner_secret: OWNER_SECRET,
        decision: "approve"
      }),
      redirect: "manual"
    });
    expect(approval.status).toBe(303);
    const callback = new URL(approval.headers.get("location") ?? "");
    expect(callback.origin).toBe("https://client.example.com");
    expect(callback.searchParams.get("state")).toBe("http-state");

    const token = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE
      })
    });
    expect(token.status).toBe(200);
    const issued = (await token.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const unauthenticated = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );

    const authenticated = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toContain("core.ping");

    const revoked = await fetch(`${origin}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: issued.refresh_token,
        token_type_hint: "refresh_token",
        client_id: client.client_id
      })
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).toBe("");

    const afterRevocation = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {}
      })
    });
    expect(afterRevocation.status).toBe(401);
  });

  it("never reflects owner credentials in authorization failures", async () => {
    const { origin, service } = await startOAuthServer();
    const registered = service.registerClient({
      redirect_uris: ["https://client.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge("z".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();
    const page = await fetch(authorizeUrl);
    const transactionId = transactionFromHtml(await page.text());
    const submittedSecret = "this must never be reflected";

    const response = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        owner_secret: submittedSecret,
        decision: "approve"
      })
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(submittedSecret);
    expect(transactionFromHtml(body)).toBe(transactionId);
  });

  it("rate-limits and audits repeated owner authentication attempts by direct peer", async () => {
    const events: AuthAuditEvent[] = [];
    const { origin, service } = await startOAuthServer(undefined, (event) => events.push(event));
    const registered = service.registerClient({
      redirect_uris: ["https://client.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge("r".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();
    const page = await fetch(authorizeUrl);
    const transactionId = transactionFromHtml(await page.text());

    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await fetch(`${origin}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          transaction_id: transactionId,
          owner_secret: "wrong owner passphrase",
          decision: "approve"
        })
      });
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(await response?.json()).toMatchObject({
      error: "too_many_requests"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "rate_limit.triggered",
        outcome: "failure",
        operation: "owner_authentication"
      })
    );
  });
});
