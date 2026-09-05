/**
 * New core.exec command-catalog flow — HTTP/MCP end-to-end.
 * Proves resolved runRoots + global command catalog through OAuth, tools/list and tools/call.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";

const TEST_RESOURCE = "https://mcp.example.com/mcp";
const OWNER_SECRET = "exec-command-catalog-e2e-owner";
const servers: Server[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

function headers(accessToken: string) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18"
  };
}

async function runtime(options: { readonly roots: readonly string[] }) {
  const oauth = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET)
  });
  const client = oauth.registerClient({
    redirect_uris: ["https://client.example.com/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "x".repeat(43);
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: TEST_RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER_SECRET);
  const tokens = oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });

  const compiled = await compilePolicyDocument(
    { schemaVersion: 2, paths: [...options.roots] },
    compileCommandCatalog([["node", "--version"]])
  );
  const server = createGatewayServer({
    oauthService: oauth,
    activePolicy: buildActivePolicySnapshot(compiled)
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return { origin: `http://127.0.0.1:${address.port}`, accessToken: tokens.access_token };
}

async function listTools(origin: string, accessToken: string): Promise<string[]> {
  const payload = (await readMcpPayload(
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    })
  )) as { result?: { tools?: { name?: string }[] } };
  return (payload.result?.tools ?? []).flatMap((tool) =>
    tool.name === undefined ? [] : [tool.name]
  );
}

async function callExec(
  origin: string,
  accessToken: string,
  id: number,
  args: Record<string, unknown>
): Promise<{
  readonly isError?: boolean;
  readonly content?: readonly { readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
}> {
  const payload = (await readMcpPayload(
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "core.exec", arguments: args }
      })
    })
  )) as {
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
  return payload.result ?? {};
}

describe("core.exec command catalog HTTP/MCP", () => {
  it("exposes and executes an allowed restricted command with one root", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-exec-one-"));
    cleanup.push(root);
    const { origin, accessToken } = await runtime({ roots: [root] });

    expect(await listTools(origin, accessToken)).toContain("core.exec");
    const result = await callExec(origin, accessToken, 2, {
      command: "node",
      args: ["--version"],
      dryRun: false
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.applied).toBe(true);
    expect(String(result.structuredContent?.stdout ?? "")).toMatch(/^v\d+/u);
  });

  it("denies zero args, disallowed subcommands and unknown commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-exec-deny-"));
    cleanup.push(root);
    const { origin, accessToken } = await runtime({ roots: [root] });

    for (const [id, args] of [
      [2, { command: "node", args: [] }],
      [3, { command: "node", args: ["-e", "console.log('no')"] }],
      [4, { command: "git", args: ["status"] }]
    ] as const) {
      const result = await callExec(origin, accessToken, id, args);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("capability_denied");
    }
  });

  it("requires root selection with multiple roots and rejects outside roots", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "slnctrz-exec-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "slnctrz-exec-b-"));
    const outside = await mkdtemp(join(tmpdir(), "slnctrz-exec-outside-"));
    cleanup.push(rootA, rootB, outside);
    const { origin, accessToken } = await runtime({ roots: [rootA, rootB] });

    const missing = await callExec(origin, accessToken, 2, {
      command: "node",
      args: ["--version"]
    });
    expect(missing.isError).toBe(true);
    expect(missing.content?.[0]?.text).toContain("Run root selection is required");

    const denied = await callExec(origin, accessToken, 3, {
      command: "node",
      args: ["--version"],
      root: outside
    });
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain("Run root is not authorized");

    const allowed = await callExec(origin, accessToken, 4, {
      command: "node",
      args: ["--version"],
      root: rootB,
      dryRun: true
    });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent?.applied).toBe(false);
  });
});
