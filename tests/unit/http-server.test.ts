import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { type ExtensionRuntimeCatalog } from "../../src/extension/runtime.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { type ExecCommandDefinition } from "../../src/kernel/exec.js";
import { type ToolAuditEvent } from "../../src/observability/tool-audit.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import {
  buildActivePolicySnapshot,
  type ActivePolicySnapshot
} from "../../src/policy/policy-snapshot.js";
import {
  createPolicySnapshotStore,
  type PolicySnapshotStore
} from "../../src/policy/policy-store.js";

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
  execRoot?: string,
  execCommands?: readonly ExecCommandDefinition[],
  activePolicyFactory?: (clientId: string) => Promise<ActivePolicySnapshot>,
  policyStoreFactory?: (clientId: string) => Promise<PolicySnapshotStore>
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
              ...(readRoot === undefined ? {} : { readRoot }),
              ...(writeRoot === undefined ? {} : { writeRoot }),
              ...(execRoot === undefined ? {} : { execRoot }),
              ...(execCommands === undefined ? {} : { execCommands })
            })
          }
        : { activePolicy }),
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
            edits: [{ oldText: "world", newText: "there" }],
            dryRun: false
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

  it("core.edit defaults to a non-mutating dry-run and rejects a stale hash", async () => {
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

    const dryPayload = (await call(10, "core.edit", {
      path: "doc.txt",
      expectedSha256: baseSha,
      edits: [{ oldText: "world", newText: "there" }]
    })) as { result?: { structuredContent?: { applied?: boolean } } };
    expect(dryPayload.result?.structuredContent).toEqual(
      expect.objectContaining({ applied: false })
    );
    expect(await readFile(target, "utf8")).toBe("hello world");

    const stalePayload = (await call(11, "core.edit", {
      path: "doc.txt",
      expectedSha256: "0".repeat(64),
      edits: [{ oldText: "world", newText: "there" }],
      dryRun: false
    })) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(stalePayload.result?.isError).toBe(true);
    expect(stalePayload.result?.content?.[0]?.text).toMatch(/^conflict:/u);
  });

  it.skipIf(process.platform === "win32")(
    "runs policy-authorized core.exec with a fixed command",
    async () => {
      const execRoot = await mkdtemp(join(tmpdir(), "slnctrz-mcp-exec-"));
      temporaryDirectories.push(execRoot);
      const script = join(execRoot, "tool.sh");
      await writeFile(script, '#!/bin/sh\necho "exec-ok"\n', { mode: 0o755 });
      await chmod(script, 0o755);
      const binaryPath = await realpath(script);
      const execRootReal = await realpath(execRoot);
      const execCommand: ExecCommandDefinition = {
        commandId: "tool",
        binaryPath,
        fixedArgs: [],
        allowExtraArgs: false,
        maxExtraArgs: 0,
        cwdMode: "fixed",
        fixedEnv: {},
        allowStdin: false,
        commandClass: "inspect"
      };

      const { origin, accessToken, auditEvents } = await startTestServer(
        undefined,
        undefined,
        execRootReal,
        [execCommand]
      );
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      };
      const call = async (id: number, args: unknown): Promise<unknown> => {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "core.exec", arguments: args }
          })
        });
        return readMcpPayload(response);
      };

      const listPayload = (await readMcpPayload(
        await fetch(`${origin}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} })
        })
      )) as { result?: { tools?: { name?: string }[] } };
      expect(listPayload.result?.tools?.map((tool) => tool.name)).toEqual([
        "core.ping",
        "core.exec"
      ]);

      const dry = (await call(21, { commandId: "tool" })) as {
        result?: { structuredContent?: { applied?: boolean } };
      };
      expect(dry.result?.structuredContent).toEqual(expect.objectContaining({ applied: false }));

      const run = (await call(22, { commandId: "tool", dryRun: false })) as {
        result?: { structuredContent?: { applied?: boolean; exitCode?: number; stdout?: string } };
      };
      expect(run.result?.structuredContent).toEqual(
        expect.objectContaining({ applied: true, exitCode: 0 })
      );
      expect(run.result?.structuredContent?.stdout).toContain("exec-ok");

      const unknown = (await call(23, { commandId: "does-not-exist" })) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(unknown.result?.isError).toBe(true);

      expect(auditEvents).toHaveLength(3);
      // The authorized dry-run and real run record the (caller-trusted) commandId; the
      // unknown-command attempt must never record the raw caller input.
      expect(JSON.stringify(auditEvents[0])).toContain('"commandId":"tool"');
      expect(JSON.stringify(auditEvents[1])).toContain('"commandId":"tool"');
      expect(JSON.stringify(auditEvents[2])).not.toContain("commandId");
      for (const event of auditEvents) {
        expect(JSON.stringify(event)).not.toContain("exec-ok");
      }
    }
  );

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

describe("per-request policy resolution (Phase 4)", () => {
  async function policySnapshot(
    clientId: string,
    workspaces: {
      id: string;
      roots: { read?: string; write?: string; exec?: string };
      profiles: ("read-only" | "minimal" | "custom")[];
    }[],
    options: { boundWorkspaceIds?: string[] } = {}
  ): Promise<ActivePolicySnapshot> {
    const compiled = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces,
      clientBindings: [
        { clientId, workspaceIds: options.boundWorkspaceIds ?? workspaces.map((w) => w.id) }
      ]
    });
    return buildActivePolicySnapshot(compiled);
  }

  async function listTools(
    origin: string,
    accessToken: string,
    headers: Record<string, string> = {}
  ): Promise<string[]> {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        ...headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/list", params: {} })
    });
    const payload = (await readMcpPayload(response)) as {
      result?: { tools?: { name?: string }[] };
    };
    return (payload.result?.tools ?? []).map((tool) => tool.name ?? "");
  }

  it("exposes only core.ping when no workspace is configured", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) => policySnapshot(clientId, [])
    );
    expect(await listTools(origin, accessToken)).toEqual(["core.ping"]);
  });

  it("returns 403 when the workspace header is missing for a configured workspace", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }])
    );
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "workspace_denied", message: "workspace header required" }
    });
  });

  it("rejects an invalid workspace header (comma/whitespace/overlength)", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }])
    );
    for (const bad of ["a,b", "a b", "x".repeat(65)]) {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-slnctrz-workspace": bad
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} })
      });
      expect(response.status).toBe(403);
    }
  });

  it("denies a client selecting a workspace it is not bound to", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(
          clientId,
          [
            { id: "a", roots: { read: "/r" }, profiles: ["read-only"] },
            { id: "b", roots: { read: "/r2" }, profiles: ["read-only"] }
          ],
          { boundWorkspaceIds: ["a"] }
        )
    );
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-slnctrz-workspace": "b"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(403);
  });

  it("requires an explicit profile for a multi-profile workspace", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [
          {
            id: "a",
            roots: { read: "/r", write: "/w" },
            profiles: ["read-only", "minimal"]
          }
        ])
    );
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-slnctrz-workspace": "a"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 44, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(403);
  });

  it("read-only never exposes write/edit/exec even when roots exist", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [
          { id: "a", roots: { read: "/r", write: "/w" }, profiles: ["read-only"] }
        ])
    );
    expect(await listTools(origin, accessToken, { "x-slnctrz-workspace": "a" })).toEqual([
      "core.ping",
      "core.read",
      "core.search"
    ]);
  });

  it("yields different tool lists for different profiles of one workspace", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [
          { id: "a", roots: { read: "/r", write: "/w" }, profiles: ["read-only", "minimal"] }
        ])
    );
    const readOnly = await listTools(origin, accessToken, {
      "x-slnctrz-workspace": "a",
      "x-slnctrz-profile": "read-only"
    });
    const minimal = await listTools(origin, accessToken, {
      "x-slnctrz-workspace": "a",
      "x-slnctrz-profile": "minimal"
    });
    expect(readOnly).toEqual(["core.ping", "core.read", "core.search"]);
    expect(minimal).toEqual(["core.ping", "core.read", "core.search", "core.write", "core.edit"]);
  });

  it("audits a mutation tool once through the resolved active policy, secret-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-policy-"));
    temporaryDirectories.push(root);
    const { origin, accessToken, auditEvents } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [
          { id: "a", roots: { read: "/r", write: root }, profiles: ["minimal"] }
        ])
    );
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-slnctrz-workspace": "a"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 46,
        method: "tools/call",
        params: {
          name: "core.write",
          arguments: { path: "out.txt", content: "hello", dryRun: false }
        }
      })
    });
    await readMcpPayload(response);
    expect(response.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      workspaceId: "a",
      toolId: "core.write",
      riskClass: "write",
      result: "success"
    });
    expect(auditEvents[0]?.policyVersion).toMatch(/^[a-f0-9]{16}$/u);
    const line = JSON.stringify(auditEvents[0]);
    expect(line).not.toContain("out.txt");
    expect(line).not.toContain("hello");
    expect(line).not.toContain(root);
  });

  it("applies the resolved read root and policy version into the exchange", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) =>
        policySnapshot(clientId, [
          { id: "a", roots: { read: "/r", write: "/w" }, profiles: ["read-only"] }
        ])
    );
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-slnctrz-workspace": "a"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: { name: "core.read", arguments: { path: "missing.txt" } }
      })
    });
    const payload = (await readMcpPayload(response)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(response.status).toBe(200);
    // read-only resolves core.read with readRoot "/r" (nonexistent): the call dispatches to
    // core.read and errors because that resolved root is not a real file -> proves the
    // resolved snapshot (not a default root) reached and drove the tool exchange.
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toMatch(/^[a-z_]+:/u);
  });
});

describe("policy snapshot store through HTTP (Phase 4 slice 3)", () => {
  async function storeSnapshot(
    clientId: string,
    workspaces: {
      id: string;
      roots: { read?: string; write?: string; exec?: string };
      profiles: ("read-only" | "minimal" | "custom")[];
    }[],
    boundWorkspaceIds?: string[]
  ): Promise<ActivePolicySnapshot> {
    const compiled = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces,
      clientBindings: [{ clientId, workspaceIds: boundWorkspaceIds ?? workspaces.map((w) => w.id) }]
    });
    return buildActivePolicySnapshot(compiled);
  }

  async function listTools(
    origin: string,
    accessToken: string,
    headers: Record<string, string> = {}
  ): Promise<string[]> {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        ...headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/list", params: {} })
    });
    const payload = (await readMcpPayload(response)) as {
      result?: { tools?: { name?: string }[] };
    };
    return (payload.result?.tools ?? []).map((tool) => tool.name ?? "");
  }

  it("calls through the store and is deny-all (ping only) until reload", async () => {
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) => {
        const initial = await storeSnapshot(clientId, []);
        return createPolicySnapshotStore(async () => initial, initial);
      }
    );
    expect(await listTools(origin, accessToken)).toEqual(["core.ping"]);
  });

  it("a valid reload changes the future request view", async () => {
    let loadCount = 0;
    let store: PolicySnapshotStore | undefined;
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) => {
        const denyAll = await storeSnapshot(clientId, []);
        const readA = await storeSnapshot(clientId, [
          { id: "a", roots: { read: "/r" }, profiles: ["read-only"] }
        ]);
        store = createPolicySnapshotStore(
          async () => {
            loadCount += 1;
            return readA;
          },
          denyAll,
          { approval: async () => "approved" }
        );
        return store;
      }
    );
    expect(await listTools(origin, accessToken)).toEqual(["core.ping"]);

    const result = await store?.reload();
    expect(result?.activated).toBe(true);
    expect(await listTools(origin, accessToken, { "x-slnctrz-workspace": "a" })).toEqual([
      "core.ping",
      "core.read",
      "core.search"
    ]);
    expect(loadCount).toBe(1);
  });

  it("a delayed request keeps the old snapshot even after a reload (no hybrid)", async () => {
    let release: ((value: ActivePolicySnapshot) => void) | undefined;
    let writeB: ActivePolicySnapshot | undefined;
    let store: PolicySnapshotStore | undefined;
    const { origin, accessToken } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) => {
        const readA = await storeSnapshot(clientId, [
          { id: "a", roots: { read: "/r" }, profiles: ["read-only"] }
        ]);
        writeB = await storeSnapshot(clientId, [
          { id: "b", roots: { read: "/r2", write: "/w2" }, profiles: ["minimal"] }
        ]);
        store = createPolicySnapshotStore(
          () =>
            new Promise<ActivePolicySnapshot>((resolve) => {
              // A reload is in flight so the store still points at the old snapshot until it settles.
              release = resolve;
            }),
          readA,
          { approval: async () => "approved" }
        );
        return store;
      }
    );

    // First request resolves against the captured old snapshot (workspace "a").
    const firstTools = await listTools(origin, accessToken, { "x-slnctrz-workspace": "a" });
    expect(firstTools).toEqual(["core.ping", "core.read", "core.search"]);

    // Begin a reload (in flight) that is still pointed at the old snapshot, then finish it.
    const reloading = store?.reload();
    release?.(writeB as ActivePolicySnapshot);
    await reloading;

    // New requests observe the new snapshot; "a" is now unknown -> 403.
    const second = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "x-slnctrz-workspace": "a"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 51, method: "tools/list", params: {} })
    });
    expect(second.status).toBe(403);
    // The old request captured A and still resolved against it; there was no hybrid merge.
    expect(firstTools).toEqual(["core.ping", "core.read", "core.search"]);
  });
});

describe("extension MCP discovery and dispatch (Phase 5 slice 3)", () => {
  it("exposes only ready authorized tools, routes canonical IDs, and emits secret-free audit", async () => {
    const invocations: { toolId: string; args: unknown }[] = [];
    let providerReady = true;
    const { origin, accessToken, auditEvents } = await startTestServer(
      undefined,
      undefined,
      undefined,
      undefined,
      async (clientId) => {
        const compiled = await compilePolicyDocument({
          schemaVersion: 1,
          extensions: [
            {
              id: "github",
              transport: "stdio",
              version: "1.0.0",
              command: "/usr/local/bin/github-mcp",
              tools: [{ canonicalId: "github.search", riskClass: "read" }]
            }
          ],
          workspaces: [
            {
              id: "a",
              roots: { read: "/r" },
              profiles: ["read-only", "minimal"],
              extensionGrants: [{ providerId: "github", profiles: ["minimal"] }]
            },
            { id: "b", roots: { read: "/r2" }, profiles: ["read-only"] }
          ],
          clientBindings: [{ clientId, workspaceIds: ["a", "b"] }]
        });
        const runtime: ExtensionRuntimeCatalog = {
          registry: compiled.extensionRegistry,
          provider: (providerId) =>
            providerId !== "github"
              ? undefined
              : {
                  state: "ready",
                  start: async () => undefined,
                  health: () => "ready",
                  invoke: async (toolId, args) => {
                    invocations.push({ toolId, args });
                    return { isError: false, truncated: false, text: "provider-ok" };
                  },
                  stop: async () => undefined
                },
          isReady: (providerId) => providerReady && providerId === "github",
          acquire: () => () => undefined,
          retire: () => undefined,
          stop: async () => undefined
        };
        return buildActivePolicySnapshot(compiled, runtime);
      }
    );
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "x-slnctrz-workspace": "a",
      "x-slnctrz-profile": "minimal"
    };

    const list = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/list", params: {} })
    });
    const listed = (await readMcpPayload(list)) as { result?: { tools?: { name?: string }[] } };
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("github.search");

    const call = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 71,
        method: "tools/call",
        params: { name: "github.search", arguments: { query: "must-not-audit" } }
      })
    });
    const called = (await readMcpPayload(call)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(called.result?.isError).not.toBe(true);
    expect(called.result?.content?.[0]?.text).toBe("provider-ok");
    expect(invocations).toEqual([{ toolId: "github.search", args: { query: "must-not-audit" } }]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      providerId: "github",
      canonicalToolId: "github.search",
      workspaceId: "a",
      result: "success"
    });
    expect(JSON.stringify(auditEvents[0])).not.toContain("must-not-audit");

    providerReady = false;
    const unavailable = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/list", params: {} })
    });
    const unavailablePayload = (await readMcpPayload(unavailable)) as {
      result?: { tools?: { name?: string }[] };
    };
    expect(unavailablePayload.result?.tools?.map((tool) => tool.name)).not.toContain(
      "github.search"
    );

    providerReady = true;
    const denied = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { ...headers, "x-slnctrz-profile": "read-only" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 74, method: "tools/list", params: {} })
    });
    const deniedPayload = (await readMcpPayload(denied)) as {
      result?: { tools?: { name?: string }[] };
    };
    expect(deniedPayload.result?.tools?.map((tool) => tool.name)).not.toContain("github.search");

    const crossWorkspace = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "x-slnctrz-workspace": "b",
        "x-slnctrz-profile": "read-only"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/list", params: {} })
    });
    const crossWorkspacePayload = (await readMcpPayload(crossWorkspace)) as {
      result?: { tools?: { name?: string }[] };
    };
    expect(crossWorkspacePayload.result?.tools?.map((tool) => tool.name)).not.toContain(
      "github.search"
    );
  });
});
