import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import {
  createExtensionRuntimeCatalog,
  type ExtensionRuntimeCatalog
} from "../../src/extension/runtime.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { createMcpCredentialStore } from "../../src/owner/mcp-credential-store.js";

const TEST_RESOURCE = "https://mcp.example.com/mcp";
const TEST_OWNER_SECRET = "extension-e2e-owner-secret";
const SERVERS: Server[] = [];
const RUNTIMES: ExtensionRuntimeCatalog[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    SERVERS.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(RUNTIMES.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

async function readMcpPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (data === undefined) throw new Error("MCP SSE response has no data frame");
    return JSON.parse(data) as unknown;
  }
  return JSON.parse(body) as unknown;
}

async function writeStdioProvider(root: string): Promise<string> {
  const provider = join(root, "provider.mjs");
  await writeFile(
    provider,
    `process.stdin.setEncoding("utf8");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk;
  while (true) {
    const index = carry.indexOf("\\n");
    if (index < 0) break;
    const line = carry.slice(0, index);
    carry = carry.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    let result = {};
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-upstream", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "upstream:" + String(message.params?.arguments?.text ?? "") }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    "utf8"
  );
  return provider;
}

async function writeCredentialStdioProvider(root: string): Promise<string> {
  const provider = join(root, "credential-provider.mjs");
  await writeFile(
    provider,
    `if (process.env.MOCK_PROVIDER_TOKEN !== "expected-upstream-secret") process.exit(23);
process.stdin.setEncoding("utf8");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk;
  while (true) {
    const index = carry.indexOf("\\n");
    if (index < 0) break;
    const line = carry.slice(0, index);
    carry = carry.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    let result = {};
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "credential-upstream", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Secured echo", inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "secured:" + String(message.params?.arguments?.text ?? "") }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    "utf8"
  );
  return provider;
}

async function issueAccessToken(oauthService: OAuthService): Promise<string> {
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
  return oauthService.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_verifier: verifier,
    resource: TEST_RESOURCE
  }).access_token;
}

function mcpHeaders(accessToken: string) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18"
  };
}

describe("extension gateway downstream-to-upstream end-to-end", () => {
  it("resolves an opaque credential ref through managed state before invoking an upstream MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-extension-credential-e2e-"));
    cleanup.push(root);
    const provider = await writeCredentialStdioProvider(root);
    const credentialStore = createMcpCredentialStore(join(root, "credentials"));
    await credentialStore.set("secured-token", {
      kind: "env",
      name: "MOCK_PROVIDER_TOKEN",
      value: "expected-upstream-secret"
    });

    const oauthService = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: new URL(TEST_RESOURCE),
      ownerSecretHash: createOwnerSecretHash(TEST_OWNER_SECRET)
    });
    const accessToken = await issueAccessToken(oauthService);
    await oauthService.verifyAccessToken(accessToken);

    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: [root] }, undefined, [
      {
        id: "secured",
        transport: "stdio",
        version: "1.0.0",
        command: process.execPath,
        args: [provider],
        envAllowlist: ["MOCK_PROVIDER_TOKEN"],
        credentialRefs: ["secured-token"],
        tools: [{ canonicalId: "secured.echo", riskClass: "read" }]
      }
    ]);
    const runtime = await createExtensionRuntimeCatalog(
      compiled.extensionRegistry,
      undefined,
      (refs) => credentialStore.resolve(refs)
    );
    RUNTIMES.push(runtime);
    expect(runtime.isReady("secured")).toBe(true);
    const activePolicy = buildActivePolicySnapshot(compiled, runtime);
    const server = createGatewayServer({ oauthService, activePolicy });
    SERVERS.push(server);
    const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    const call = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(accessToken),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "secured.echo", arguments: { text: "hello" } }
        })
      })
    )) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(call.result?.isError).not.toBe(true);
    expect(call.result?.content?.[0]?.text).toBe("secured:hello");
  });

  it("exposes and invokes a granted stdio upstream MCP tool through the public gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-extension-e2e-"));
    cleanup.push(root);
    const provider = await writeStdioProvider(root);

    const oauthService = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: new URL(TEST_RESOURCE),
      ownerSecretHash: createOwnerSecretHash(TEST_OWNER_SECRET)
    });
    const accessToken = await issueAccessToken(oauthService);
    await oauthService.verifyAccessToken(accessToken);

    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: [root] }, undefined, [
      {
        id: "mock",
        transport: "stdio",
        version: "1.0.0",
        command: process.execPath,
        args: [provider],
        tools: [{ canonicalId: "mock.echo", riskClass: "read" }]
      }
    ]);
    const runtime = await createExtensionRuntimeCatalog(compiled.extensionRegistry);
    RUNTIMES.push(runtime);
    expect(runtime.isReady("mock")).toBe(true);
    const activePolicy = buildActivePolicySnapshot(compiled, runtime);

    const server = createGatewayServer({ oauthService, activePolicy });
    SERVERS.push(server);
    const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    const list = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(accessToken),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      })
    )) as { result?: { tools?: { name?: string }[] } };
    const names = (list.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("mock.echo");

    const call = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(accessToken),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "mock.echo", arguments: { text: "hello" } }
        })
      })
    )) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(call.result?.isError).not.toBe(true);
    expect(call.result?.content?.[0]?.text).toBe("upstream:hello");
  });

  it("exposes and invokes a granted Streamable HTTP upstream MCP tool through the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-extension-http-e2e-"));
    cleanup.push(root);
    // A safe upstream stand-in: exercises the real gateway -> streamable-http adapter
    // negotiation path with a mock transport, matching the adapter unit-test seam. HTTPS
    // endpoint remains required by the manifest (secure transport invariant), so the fetch
    // is mocked rather than opened against a self-signed local TLS server.
    const downstreamFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        _input instanceof Request
          ? new URL(_input.url)
          : _input instanceof URL
            ? _input
            : new URL(_input);
      if (requestUrl.hostname === "127.0.0.1") {
        return downstreamFetch(_input, init);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, string> };
      };
      let result: {
        supportedVersions?: string[];
        capabilities?: { tools?: object };
        tools?: { name: string }[];
        content?: { type: string; text: string }[];
      } = {};
      if (body.method === "server/discover") {
        result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
      } else if (body.method === "tools/list") {
        result = { tools: [{ name: "foo.bar" }, { name: "dangerous_extra" }] };
      } else if (body.method === "tools/call") {
        expect(body.params?.name).toBe("foo.bar");
        result = {
          content: [{ type: "text", text: "http:" + String(body.params?.arguments?.text ?? "") }]
        };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const oauthService = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: new URL(TEST_RESOURCE),
      ownerSecretHash: createOwnerSecretHash(TEST_OWNER_SECRET)
    });
    const accessToken = await issueAccessToken(oauthService);
    await oauthService.verifyAccessToken(accessToken);

    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: [root] }, undefined, [
      {
        id: "remotemock",
        transport: "streamable-http",
        version: "1.0.0",
        endpoint: "https://provider.example.com/mcp",
        tools: [{ canonicalId: "remotemock.foo.bar", riskClass: "read" }]
      }
    ]);
    const runtime = await createExtensionRuntimeCatalog(compiled.extensionRegistry);
    RUNTIMES.push(runtime);
    expect(runtime.isReady("remotemock")).toBe(true);
    const activePolicy = buildActivePolicySnapshot(compiled, runtime);
    const server = createGatewayServer({ oauthService, activePolicy });
    SERVERS.push(server);
    const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    const list = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(accessToken),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      })
    )) as { result?: { tools?: { name?: string }[] } };
    const exposed = (list.result?.tools ?? []).map((tool) => tool.name);
    expect(exposed).toContain("remotemock.foo.bar");
    expect(exposed).not.toContain("remotemock.dangerous_extra");

    const call = (await readMcpPayload(
      await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: mcpHeaders(accessToken),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "remotemock.foo.bar", arguments: { text: "hello" } }
        })
      })
    )) as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } };
    expect(call.result?.isError).not.toBe(true);
    expect(call.result?.content?.[0]?.text).toBe("http:hello");
  });
});
