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
import { createTaskRuntime } from "../../src/task/runtime.js";

const RESOURCE = "https://mcp.example.com/mcp";
const OWNER = "orientation-owner";
const servers: Server[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function authorize(oauth: OAuthService): string {
  const client = oauth.registerClient({
    redirect_uris: ["https://orientation.example.com/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "orientation".padEnd(43, "x");
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://orientation.example.com/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER);
  return oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://orientation.example.com/callback",
    code_verifier: verifier,
    resource: RESOURCE
  }).access_token;
}

interface RpcPayload {
  readonly result?: {
    readonly tools?: readonly { readonly name?: string }[];
    readonly structuredContent?: Record<string, unknown>;
  };
}

interface ManagedTaskOrientation {
  readonly enabled: boolean;
  readonly persistence: string;
  readonly advertisedTools: readonly string[];
  readonly runner: { readonly canStart: boolean };
  readonly coordinator: { readonly available: boolean };
}

async function rpc(
  origin: string,
  token: string,
  id: number,
  method: string,
  params: Record<string, unknown>
) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : body;
  if (data === undefined) throw new Error("missing MCP payload");
  return JSON.parse(data) as RpcPayload;
}

async function fixture(taskRuntime: boolean, exec: boolean) {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-orientation-"));
  cleanup.push(root);
  const oauth = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER)
  });
  const token = authorize(oauth);
  const compiled = await compilePolicyDocument(
    { schemaVersion: 2, paths: [root] },
    exec ? compileCommandCatalog([["node"]]) : undefined
  );
  const server = createGatewayServer({
    oauthService: oauth,
    activePolicy: buildActivePolicySnapshot(compiled),
    ...(taskRuntime ? { taskRuntime: createTaskRuntime() } : {})
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return { origin: `http://127.0.0.1:${address.port}`, token };
}

describe("core.ping managed task orientation", () => {
  for (const testCase of [
    { runtime: false, exec: false },
    { runtime: true, exec: false },
    { runtime: true, exec: true }
  ]) {
    it(`matches tools/list when runtime=${testCase.runtime} exec=${testCase.exec}`, async () => {
      const { origin, token } = await fixture(testCase.runtime, testCase.exec);
      const listed = await rpc(origin, token, 1, "tools/list", {});
      const names = (listed.result?.tools ?? [])
        .flatMap((tool: { name?: string }) => (tool.name === undefined ? [] : [tool.name]))
        .sort();
      const ping = await rpc(origin, token, 2, "tools/call", { name: "core.ping", arguments: {} });
      const structured = ping.result?.structuredContent;
      const managed = structured?.managedTasks as ManagedTaskOrientation | undefined;
      const workspace = structured?.workspace as
        { readonly capabilities?: readonly string[] } | undefined;
      const capabilities = [...(workspace?.capabilities ?? [])];
      const taskNames = names.filter((name: string) => name.startsWith("task."));

      expect(managed?.advertisedTools).toEqual(taskNames);
      expect(managed?.enabled).toBe(testCase.runtime);
      expect(managed?.persistence).toBe("in-memory");
      expect(managed?.runner.canStart).toBe(testCase.runtime && testCase.exec);
      expect(managed?.coordinator.available).toBe(testCase.runtime);
      expect(capabilities.includes("core.exec")).toBe(testCase.exec);
      expect(capabilities.some((name) => name.startsWith("task."))).toBe(false);
    });
  }
});
