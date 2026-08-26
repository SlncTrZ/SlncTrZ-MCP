import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";

const servers: Server[] = [];
const TEST_OWNER_SECRET = "test owner secret for gateway";
const TEST_RESOURCE = "https://mcp.example.com/mcp";

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

async function startTestServer(): Promise<{
  readonly origin: string;
  readonly accessToken: string;
}> {
  const oauthService = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(TEST_OWNER_SECRET)
  });
  const client = oauthService.registerClient({
    redirect_uris: ["https://client.example.com/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "t".repeat(43);
  const pending = oauthService.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_challenge: oauthService.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: TEST_RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauthService.approveAuthorization(pending.transactionId, TEST_OWNER_SECRET);
  const tokens = oauthService.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });

  const server = createGatewayServer({ oauthService });
  servers.push(server);
  const address = await listenGateway(server, {
    host: "127.0.0.1",
    port: 0
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    accessToken: tokens.access_token
  };
}

async function readMcpPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (data === undefined) throw new Error("MCP SSE response has no data frame");
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

async function requestWithHost(origin: string, host: string): Promise<number> {
  const url = new URL("/mcp", origin);
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json"
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      }
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

describe("gateway HTTP surface", () => {
  it("reports liveness and readiness without exposing internals", async () => {
    const { origin } = await startTestServer();

    const health = await fetch(`${origin}/healthz`);
    const readiness = await fetch(`${origin}/readyz`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({ status: "ready" });
  });

  it("rejects unknown public routes", async () => {
    const { origin } = await startTestServer();

    const response = await fetch(`${origin}/control`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Route not found" }
    });
  });

  it("negotiates MCP and exposes only core.ping", async () => {
    const { origin, accessToken } = await startTestServer();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "phase-1-test", version: "1.0.0" }
        }
      })
    });

    expect(response.status).toBe(200);
    const payload = (await readMcpPayload(response)) as {
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
    };
    expect(payload.result?.protocolVersion).toBe("2025-06-18");
    expect(payload.result?.serverInfo?.name).toBe("slnctrz-mcp");
  });

  it("lists and calls the isolated core.ping tool", async () => {
    const { origin, accessToken } = await startTestServer();
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    };

    const listResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });
    const listPayload = (await readMcpPayload(listResponse)) as {
      result?: { tools?: { name?: string }[] };
    };

    expect(listResponse.status).toBe(200);
    expect(listPayload.result?.tools?.map((tool) => tool.name)).toEqual([
      "core.ping",
      "core.read",
      "core.search"
    ]);

    const callResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "core.ping", arguments: {} }
      })
    });
    const callPayload = (await readMcpPayload(callResponse)) as {
      result?: { content?: { text?: string }[] };
    };

    expect(callResponse.status).toBe(200);
    expect(callPayload.result?.content?.[0]?.text).toBe("pong");
  });

  it("enforces the request-body boundary before protocol dispatch", async () => {
    const { origin, accessToken } = await startTestServer();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: "x".repeat(1_048_577)
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body too large"
      }
    });
  });

  it("rejects hostile Host headers before MCP dispatch", async () => {
    const { origin } = await startTestServer();
    const status = await requestWithHost(origin, "attacker.example");

    expect(status).toBe(403);
  });
});
