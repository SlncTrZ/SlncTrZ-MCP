import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";

const servers: Server[] = [];
const TEST_OWNER_SECRET = "conformance test owner secret";
const TEST_RESOURCE = "https://mcp.example.com/mcp";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
});

async function startGateway(): Promise<{ origin: string; accessToken: string }> {
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
  const server = createGatewayServer({
    oauthService,
    kernelPolicy: createKernelPolicySnapshot({ workspaceId: "conformance" })
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return { origin: `http://127.0.0.1:${address.port}`, accessToken: tokens.access_token };
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

describe("MCP initialize conformance", () => {
  it("answers the 2026-07-28 server/discover probe", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 25,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-conformance-test",
              version: "1.0.0"
            },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    });
    const payload = (await readMcpPayload(response)) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    expect(response.status).toBe(200);
    expect(payload.error).toBeUndefined();
    expect(payload.result).toBeDefined();
  });

  it("serves 2026-07-28 tools/list with the per-request modern envelope", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 26,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-conformance-test",
              version: "1.0.0"
            },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    });
    const payload = (await readMcpPayload(response)) as {
      result?: { tools?: { name?: string }[] };
      error?: { code?: number; message?: string };
    };
    expect(response.status).toBe(200);
    expect(payload.error).toBeUndefined();
    expect(payload.result?.tools?.map((tool) => tool.name)).toContain("core.ping");
  });

  it("negotiates the supported protocol version", async () => {
    const { origin, accessToken } = await startGateway();
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
          clientInfo: { name: "conformance-test", version: "1.0.0" }
        }
      })
    });

    const payload = (await readMcpPayload(response)) as {
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
    };
    expect(response.status).toBe(200);
    expect(payload.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "slnctrz-mcp" }
    });
  });

  it("returns JSON-RPC method-not-found for an unknown authenticated method", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown/method", params: {} })
    });
    const payload = (await readMcpPayload(response)) as { error?: { code?: number } };
    expect(response.status).toBe(200);
    expect(payload.error).toMatchObject({ code: -32601 });
  });

  it("rejects malformed JSON before MCP dispatch without leaking internals", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: "{"
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_json", message: "Invalid JSON request body" }
    });
  });

  it("rejects an invalid JSON-RPC envelope before MCP dispatch", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: 3, method: "tools/list", params: {} })
    });
    const payload = (await readMcpPayload(response)) as { error?: { code?: number } };
    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({ code: -32600 });
  });

  it("rejects JSON-RPC batches for the 2025-06-18 revision", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 4, method: "ping", params: {} },
        { jsonrpc: "2.0", id: 5, method: "ping", params: {} }
      ])
    });
    const payload = (await readMcpPayload(response)) as { error?: { code?: number } };
    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({ code: -32600 });
  });

  it("accepts initialized notifications without manufacturing a response body", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      })
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("rejects an unsupported protocol version header on subsequent requests", async () => {
    const { origin, accessToken } = await startGateway();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "1999-01-01"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping", params: {} })
    });
    expect(response.status).toBe(400);
  });

  it("fails closed for a deterministic malformed-body corpus", async () => {
    const { origin, accessToken } = await startGateway();
    const corpus = ["{", "[", '"', '{"jsonrpc":', '{"x":NaN}', '{"x":1,}'];
    for (const body of corpus) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body
      });
      expect(response.status, body).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_json", message: "Invalid JSON request body" }
      });
    }
  });

  it("rejects invalid UTF-8 and unsupported media types at the HTTP boundary", async () => {
    const { origin, accessToken } = await startGateway();
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`
    };
    const invalidUtf8 = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])
    });
    expect(invalidUtf8.status).toBe(400);
    await expect(invalidUtf8.json()).resolves.toEqual({
      error: { code: "invalid_json", message: "Invalid JSON request body" }
    });

    const unsupportedMedia = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: "{}"
    });
    expect(unsupportedMedia.status).toBe(415);
    await expect(unsupportedMedia.json()).resolves.toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Unsupported request content type"
      }
    });
  });

  it("keeps stateless initialization exchanges independent", async () => {
    const { origin, accessToken } = await startGateway();
    const initialize = async (id: number): Promise<Response> =>
      fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: `client-${id}`, version: "1.0.0" }
          }
        })
      });

    const [first, second] = await Promise.all([initialize(7), initialize(7)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("mcp-session-id")).toBeNull();
    expect(second.headers.get("mcp-session-id")).toBeNull();
    const [firstPayload, secondPayload] = await Promise.all([
      readMcpPayload(first),
      readMcpPayload(second)
    ]);
    expect(firstPayload).toMatchObject({ id: 7 });
    expect(secondPayload).toMatchObject({ id: 7 });
  });

  it("rejects an unsupported protocol version without creating a session", async () => {
    const { origin, accessToken } = await startGateway();
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
          protocolVersion: "1999-01-01",
          capabilities: {},
          clientInfo: { name: "conformance-test", version: "1.0.0" }
        }
      })
    });

    const payload = (await readMcpPayload(response)) as {
      error?: { code?: number; message?: string };
      result?: unknown;
    };
    expect(response.status).toBe(400);
    expect(payload.result).toBeUndefined();
    expect(payload.error).toMatchObject({ code: -32602 });
    expect(payload.error?.message).toMatch(/unsupported MCP protocol version/i);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });
});
