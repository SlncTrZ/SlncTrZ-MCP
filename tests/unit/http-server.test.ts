import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { type ToolAuditEvent } from "../../src/observability/tool-audit.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];
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
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function startTestServer(
  readRoot?: string,
  writeRoot?: string
): Promise<{
  readonly origin: string;
  readonly accessToken: string;
  readonly auditEvents: ToolAuditEvent[];
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

  const auditEvents: ToolAuditEvent[] = [];
  const server = createGatewayServer({
    oauthService,
    kernelPolicy: createKernelPolicySnapshot({
      workspaceId: "test-workspace",
      ...(readRoot === undefined ? {} : { readRoot }),
      ...(writeRoot === undefined ? {} : { writeRoot })
    }),
    toolAudit: (event) => auditEvents.push(event)
  });
  servers.push(server);
  const address = await listenGateway(server, {
    host: "127.0.0.1",
    port: 0
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    accessToken: tokens.access_token,
    auditEvents
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
    expect(listPayload.result?.tools?.map((tool) => tool.name)).toEqual(["core.ping"]);

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

  it("calls core.read and core.search through authenticated MCP dispatch", async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), "slnctrz-mcp-tools-"));
    temporaryDirectories.push(toolRoot);
    await writeFile(join(toolRoot, "alpha.txt"), "alpha content", "utf8");
    await writeFile(join(toolRoot, ".env"), "must-not-leak", "utf8");

    const { origin, accessToken } = await startTestServer(toolRoot);
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    };

    const readResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "core.read", arguments: { path: "alpha.txt" } }
      })
    });
    const readPayload = (await readMcpPayload(readResponse)) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    expect(readResponse.status).toBe(200);
    expect(readPayload.result?.isError).not.toBe(true);
    expect(readPayload.result?.content?.[0]?.text).toBe("alpha content");

    const searchResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "core.search", arguments: { pattern: ".txt" } }
      })
    });
    const searchPayload = (await readMcpPayload(searchResponse)) as {
      result?: {
        structuredContent?: {
          matches?: string[];
          truncated?: boolean;
        };
      };
    };
    expect(searchResponse.status).toBe(200);
    expect(searchPayload.result?.structuredContent).toEqual(
      expect.objectContaining({
        matches: ["alpha.txt"],
        truncated: false
      })
    );
  });

  it("exposes policy-authorized core.write and emits a secret-free audit event", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-write-"));
    temporaryDirectories.push(root);

    const { origin, accessToken, auditEvents } = await startTestServer(root, root);
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
        id: 6,
        method: "tools/list",
        params: {}
      })
    });
    const listPayload = (await readMcpPayload(listResponse)) as {
      result?: { tools?: { name?: string }[] };
    };
    expect(listPayload.result?.tools?.map((tool) => tool.name)).toEqual([
      "core.ping",
      "core.read",
      "core.search",
      "core.write"
    ]);

    const writeResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "core.write",
          arguments: { path: "created.txt", content: "created atomically", dryRun: false }
        }
      })
    });
    const writePayload = (await readMcpPayload(writeResponse)) as {
      result?: { structuredContent?: { applied?: boolean; created?: boolean } };
    };

    expect(writeResponse.status).toBe(200);
    expect(writePayload.result?.structuredContent).toEqual(
      expect.objectContaining({ applied: true, created: true })
    );
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created atomically");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toEqual(
      expect.objectContaining({
        workspaceId: "test-workspace",
        toolId: "core.write",
        riskClass: "write",
        decision: "allow",
        result: "success"
      })
    );
    expect(auditEvents[0]?.clientId).toEqual(expect.any(String));
    expect(auditEvents[0]?.policyVersion).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify(auditEvents[0])).not.toContain("created.txt");
    expect(JSON.stringify(auditEvents[0])).not.toContain("created atomically");
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
