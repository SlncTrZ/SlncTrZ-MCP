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
  audit?: AuthAuditSink,
  staticRedirectStore?: OAuthServiceOptions["staticRedirectStore"]
): Promise<{
  readonly origin: string;
  readonly service: OAuthService;
}> {
  const service = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
    ...(staticClient === undefined ? {} : { staticClient }),
    ...(audit === undefined ? {} : { audit }),
    ...(staticRedirectStore === undefined ? {} : { staticRedirectStore })
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

  it("owner-approves and persists an unseen Gemini callback in one HTTP flow", async () => {
    const clientId = "custom-static-client";
    const clientSecret = "server-side-client-secret";
    const redirectUri =
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-http_flow";
    const saved: string[] = [];
    const { origin, service } = await startOAuthServer(
      {
        clientId,
        clientSecret,
        clientName: "Gemini MCP",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"]
      },
      undefined,
      {
        add: (savedClientId, savedRedirect) => {
          expect(savedClientId).toBe(clientId);
          if (!saved.includes(savedRedirect)) saved.push(savedRedirect);
          return [...saved];
        }
      }
    );
    const verifier = "i".repeat(43);
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools",
      state: "gemini-state"
    }).toString();

    const page = await fetch(authorizeUrl);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("New Gemini callback");
    expect(html).toContain(clientId);
    expect(html).toContain(redirectUri);
    expect(saved).toEqual([]);
    const transactionId = transactionFromHtml(html);

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
    expect(saved).toEqual([redirectUri]);
    const callback = new URL(approval.headers.get("location") ?? "");
    expect(callback.origin).toBe("https://oauth-redirect.googleusercontent.com");
    expect(callback.searchParams.get("state")).toBe("gemini-state");

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
  });

  it("does not redirect to an unseen Gemini callback when the owner denies it", async () => {
    const redirectUri =
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-denied";
    const { origin, service } = await startOAuthServer(
      {
        clientId: "custom-static-client",
        clientSecret: "secret",
        redirectUris: ["https://claude.ai/api/mcp/auth_callback"]
      },
      undefined,
      {
        add: () => {
          throw new Error("must not persist");
        }
      }
    );
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "custom-static-client",
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge("n".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();
    const page = await fetch(authorizeUrl);
    const transactionId = transactionFromHtml(await page.text());

    const denial = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction_id: transactionId, decision: "deny" }),
      redirect: "manual"
    });
    expect(denial.status).toBe(200);
    expect(denial.headers.get("location")).toBeNull();
    expect(await denial.text()).toContain("callback was not registered");
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

  it("keeps an owner-authentication retry browser-safe and completes the same OAuth flow", async () => {
    const { origin, service } = await startOAuthServer();
    const redirectUri = "https://client.example.com/oauth/callback";
    const verifier = "z".repeat(43);
    const registered = service.registerClient({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none"
    });
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_challenge: service.pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();
    const page = await fetch(authorizeUrl);
    const transactionId = transactionFromHtml(await page.text());
    const submittedSecret = "this must never be reflected";

    const failed = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: transactionId,
        owner_secret: submittedSecret,
        decision: "approve"
      })
    });
    const failedBody = await failed.text();

    expect(failed.status).toBe(200);
    expect(failedBody).not.toContain(submittedSecret);
    expect(transactionFromHtml(failedBody)).toBe(transactionId);

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
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE
      })
    });
    expect(token.status).toBe(200);
  });

  it("rate-limits and audits registration and authorization allocation abuse", async () => {
    const events: AuthAuditEvent[] = [];
    const { origin, service } = await startOAuthServer(undefined, (event) => events.push(event));

    let registration: Response | undefined;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      registration = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [`https://client-${attempt}.example.com/oauth/callback`],
          token_endpoint_auth_method: "none"
        })
      });
    }
    expect(registration?.status).toBe(429);

    const clientId = service.registerClient({
      redirect_uris: ["https://client.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    }).client_id;
    const authorizeUrl = new URL("/authorize", origin);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example.com/oauth/callback",
      code_challenge: service.pkceChallenge("a".repeat(43)),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:tools"
    }).toString();

    let authorization: Response | undefined;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      authorization = await fetch(authorizeUrl);
    }
    expect(authorization?.status).toBe(429);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "rate_limit.triggered",
          operation: "registration"
        }),
        expect.objectContaining({
          type: "rate_limit.triggered",
          operation: "authorization"
        })
      ])
    );
  });

  it("does not charge successful owner approvals against the authentication failure budget", async () => {
    const { origin, service } = await startOAuthServer();
    const registered = service.registerClient({
      redirect_uris: ["https://client.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const authorizeUrl = new URL("/authorize", origin);
      authorizeUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_challenge: service.pkceChallenge(String(attempt).padStart(43, "a")),
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp:tools"
      }).toString();
      const page = await fetch(authorizeUrl);
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
    }
  });

  it("does not let failures in one authorization transaction lock out another transaction", async () => {
    const { origin, service } = await startOAuthServer();
    const first = service.registerClient({
      redirect_uris: ["https://first.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });
    const second = service.registerClient({
      redirect_uris: ["https://second.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });
    const buildAuthorizeUrl = (clientId: string, redirectUri: string, verifier: string): URL => {
      const url = new URL("/authorize", origin);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: service.pkceChallenge(verifier),
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp:tools"
      }).toString();
      return url;
    };

    const firstPage = await fetch(
      buildAuthorizeUrl(first.client_id, "https://first.example.com/oauth/callback", "f".repeat(43))
    );
    const firstTransaction = transactionFromHtml(await firstPage.text());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await fetch(`${origin}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          transaction_id: firstTransaction,
          owner_secret: "wrong owner passphrase",
          decision: "approve"
        })
      });
      expect(failed.status).toBe(200);
    }

    const secondPage = await fetch(
      buildAuthorizeUrl(
        second.client_id,
        "https://second.example.com/oauth/callback",
        "s".repeat(43)
      )
    );
    const secondTransaction = transactionFromHtml(await secondPage.text());
    const secondApproval = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction_id: secondTransaction,
        owner_secret: OWNER_SECRET,
        decision: "approve"
      }),
      redirect: "manual"
    });

    expect(secondApproval.status).toBe(303);
  }, 10_000);

  it("keeps a bounded direct-peer backstop across many failing transactions", async () => {
    const events: AuthAuditEvent[] = [];
    const { origin, service } = await startOAuthServer(undefined, (event) => events.push(event));
    const registered = service.registerClient({
      redirect_uris: ["https://client.example.com/oauth/callback"],
      token_endpoint_auth_method: "none"
    });

    let response: Response | undefined;
    for (let attempt = 0; attempt < 26; attempt += 1) {
      const authorizeUrl = new URL("/authorize", origin);
      authorizeUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: "https://client.example.com/oauth/callback",
        code_challenge: service.pkceChallenge(String(attempt).padStart(43, "p")),
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp:tools"
      }).toString();
      const page = await fetch(authorizeUrl);
      const transactionId = transactionFromHtml(await page.text());

      response = await fetch(`${origin}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": `203.0.113.${attempt + 1}`
        },
        body: new URLSearchParams({
          transaction_id: transactionId,
          owner_secret: "wrong owner passphrase",
          decision: "approve"
        })
      });

      if (attempt < 25) expect(response.status).toBe(200);
    }

    expect(response?.status).toBe(429);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "rate_limit.triggered",
        outcome: "failure",
        operation: "owner_authentication"
      })
    );
  }, 15_000);

  it("rate-limits and audits repeated owner authentication failures for one transaction", async () => {
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
  }, 10_000);
});
