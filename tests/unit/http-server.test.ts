import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createMetricsRegistry, type MetricsRegistry } from "../../src/observability/metrics.js";
import { type ToolAuditEvent } from "../../src/observability/tool-audit.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import { type ActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { type PolicySnapshotStore } from "../../src/policy/policy-store.js";

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
  writeRoot?: string,
  _legacyExecRoot?: string,
  _legacyExecCommands?: unknown,
  activePolicyFactory?: (clientId: string) => Promise<ActivePolicySnapshot>,
  policyStoreFactory?: (clientId: string) => Promise<PolicySnapshotStore>,
  readRoots?: readonly string[]
): Promise<{
  readonly origin: string;
  readonly accessToken: string;
  readonly auditEvents: ToolAuditEvent[];
  readonly metrics: MetricsRegistry;
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
  const metrics = createMetricsRegistry();
  const activePolicy =
    activePolicyFactory === undefined ? undefined : await activePolicyFactory(client.client_id);
  const policyStore =
    policyStoreFactory === undefined ? undefined : await policyStoreFactory(client.client_id);
  const server = createGatewayServer({
    oauthService,
    ...(policyStore !== undefined
      ? { policyStore }
      : activePolicy === undefined
        ? {
            kernelPolicy: createKernelPolicySnapshot({
              workspaceId: "test-workspace",
              ...(readRoots !== undefined
                ? { readRoots }
                : readRoot === undefined
                  ? {}
                  : { readRoot }),
              ...(writeRoot === undefined ? {} : { writeRoot })
            })
          }
        : { activePolicy }),
    toolAudit: (event) => auditEvents.push(event),
    metrics
  });
  servers.push(server);
  const address = await listenGateway(server, {
    host: "127.0.0.1",
    port: 0
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    accessToken: tokens.access_token,
    auditEvents,
    metrics
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
    const { origin, accessToken, metrics } = await startTestServer();
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
      result?: {
        content?: { text?: string }[];
        structuredContent?: { status?: string; workspace?: unknown };
      };
    };

    expect(callResponse.status).toBe(200);
    expect(callPayload.result?.content?.[0]?.text).toContain("SlncTrZ-MCP gateway is online");
    expect(callPayload.result?.content?.[0]?.text).toContain("docs/MODEL_GUIDE.md");
    expect(callPayload.result?.content?.[0]?.text).toContain("workspace docs");
    expect(callPayload.result?.structuredContent?.status).toBe("ok");
    expect(metrics.snapshot()).toEqual(
      expect.objectContaining({
        requestActive: 0,
        toolCallsTotal: 1,
        toolErrorsTotal: 0
      })
    );
  });

  it("never exposes owner administration as model-facing MCP tools", async () => {
    const { origin, accessToken } = await startTestServer();
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    };

    const listPayload = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/list", params: {} })
      })
    )) as {
      result?: {
        tools?: { name?: string; inputSchema?: { properties?: Record<string, unknown> } }[];
      };
    };
    const tools = listPayload.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["core.ping"]);
    expect(names.some((name) => name?.startsWith("owner."))).toBe(false);
    expect(names).not.toContain("core.read");
    expect(names).not.toContain("core.write");
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

  it("honors an explicit Restricted core.search root and preserves multi-root provenance", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "slnctrz-search-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "slnctrz-search-b-"));
    const rootC = await mkdtemp(join(tmpdir(), "slnctrz-search-c-"));
    temporaryDirectories.push(rootA, rootB, rootC);
    await writeFile(join(rootA, "a-only.txt"), "a", "utf8");
    await writeFile(join(rootB, "b-only.txt"), "b", "utf8");
    await writeFile(join(rootC, "c-only.txt"), "c", "utf8");

    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [rootA, rootB, rootC]
    );
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    };

    const explicit = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: { name: "core.search", arguments: { pattern: ".txt", root: rootB } }
      })
    });
    const explicitPayload = (await readMcpPayload(explicit)) as {
      result?: {
        isError?: boolean;
        structuredContent?: {
          matches?: string[];
          resolvedMatches?: { root: string; path: string }[];
        };
      };
    };
    expect(explicitPayload.result?.isError).not.toBe(true);
    expect(explicitPayload.result?.structuredContent?.matches).toEqual(["b-only.txt"]);
    expect(explicitPayload.result?.structuredContent?.resolvedMatches).toEqual([
      { root: await realpath(rootB), path: "b-only.txt" }
    ]);

    const allRoots = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: { name: "core.search", arguments: { pattern: ".txt" } }
      })
    });
    const allPayload = (await readMcpPayload(allRoots)) as {
      result?: {
        structuredContent?: {
          matches?: string[];
          resolvedMatches?: { root: string; path: string }[];
        };
      };
    };
    expect(allPayload.result?.structuredContent?.matches).toEqual([
      "a-only.txt",
      "b-only.txt",
      "c-only.txt"
    ]);
    expect(allPayload.result?.structuredContent?.resolvedMatches).toEqual([
      { root: rootA, path: "a-only.txt" },
      { root: rootB, path: "b-only.txt" },
      { root: rootC, path: "c-only.txt" }
    ]);

    const denied = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: { name: "core.search", arguments: { pattern: ".txt", root: "/etc" } }
      })
    });
    const deniedPayload = (await readMcpPayload(denied)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(deniedPayload.result?.isError).toBe(true);
    expect(deniedPayload.result?.content?.[0]?.text).toContain("permission_denied");
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
      "core.write",
      "core.edit"
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
          arguments: { path: "created.txt", content: "created atomically" }
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

  it("applies policy-authorized core.edit with a secret-free audit event", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-edit-"));
    temporaryDirectories.push(root);
    const target = join(root, "doc.txt");
    await writeFile(target, "hello world", "utf8");
    const baseSha = createHash("sha256").update("hello world").digest("hex");

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
        id: 8,
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
      "core.write",
      "core.edit"
    ]);

    const editResponse = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "core.edit",
          arguments: {
            path: "doc.txt",
            expectedSha256: baseSha,
            edits: [{ oldText: "world", newText: "there" }]
          }
        }
      })
    });
    const editPayload = (await readMcpPayload(editResponse)) as {
      result?: { structuredContent?: { applied?: boolean; editCount?: number } };
    };

    expect(editResponse.status).toBe(200);
    expect(editPayload.result?.structuredContent).toEqual(
      expect.objectContaining({ applied: true, editCount: 1 })
    );
    expect(await readFile(target, "utf8")).toBe("hello there");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toEqual(
      expect.objectContaining({
        workspaceId: "test-workspace",
        toolId: "core.edit",
        riskClass: "write",
        decision: "allow",
        result: "success"
      })
    );
    expect(JSON.stringify(auditEvents[0])).not.toContain("doc.txt");
    expect(JSON.stringify(auditEvents[0])).not.toContain("world");
    expect(JSON.stringify(auditEvents[0])).not.toContain("there");
  });

  it("core.edit applies by default, previews only explicitly, and rejects a stale hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-edit-"));
    temporaryDirectories.push(root);
    const target = join(root, "doc.txt");
    await writeFile(target, "hello world", "utf8");
    const baseSha = createHash("sha256").update("hello world").digest("hex");

    const { origin, accessToken } = await startTestServer(root, root);
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    };
    const call = async (id: number, name: string, args: unknown): Promise<unknown> => {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args }
        })
      });
      return readMcpPayload(response);
    };

    const previewPayload = (await call(10, "core.edit", {
      path: "doc.txt",
      expectedSha256: baseSha,
      edits: [{ oldText: "world", newText: "there" }],
      dryRun: true
    })) as { result?: { structuredContent?: { applied?: boolean } } };
    expect(previewPayload.result?.structuredContent).toEqual(
      expect.objectContaining({ applied: false })
    );
    expect(await readFile(target, "utf8")).toBe("hello world");

    const appliedPayload = (await call(11, "core.edit", {
      path: "doc.txt",
      expectedSha256: baseSha,
      edits: [{ oldText: "world", newText: "there" }]
    })) as { result?: { structuredContent?: { applied?: boolean } } };
    expect(appliedPayload.result?.structuredContent).toEqual(
      expect.objectContaining({ applied: true })
    );
    expect(await readFile(target, "utf8")).toBe("hello there");

    const stalePayload = (await call(12, "core.edit", {
      path: "doc.txt",
      expectedSha256: "0".repeat(64),
      edits: [{ oldText: "there", newText: "world" }]
    })) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(stalePayload.result?.isError).toBe(true);
    expect(stalePayload.result?.content?.[0]?.text).toMatch(/^conflict:/u);
  });

  it("enforces the request-body boundary before protocol dispatch", async () => {
    const { origin, accessToken } = await startTestServer();
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: "x".repeat(16 * 1_048_576 + 1)
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
