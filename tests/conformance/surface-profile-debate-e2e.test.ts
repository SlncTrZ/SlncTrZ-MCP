import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteOAuthGrantStore,
  type OAuthGrantStore
} from "../../src/auth/oauth-grant-store.js";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { ensureHarnessLayout } from "../../src/context/provisioning.js";
import { HarnessRuntime } from "../../src/context/runtime.js";
import { createDebateService, type DebateService } from "../../src/debate/index.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import type { ExtensionRuntimeCatalog } from "../../src/extension/runtime.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";

const OWNER_SECRET = "surface profile owner secret";
const RESOURCE = "https://gateway.test/mcp";
const cleanup: string[] = [];
const servers: Server[] = [];
const stores: OAuthGrantStore[] = [];
const debates: DebateService[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const debate of debates.splice(0)) debate.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

function issueGrant(oauth: OAuthService, clientId: string, verifier: string): string {
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.test/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER_SECRET);
  return oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: clientId,
    redirect_uri: "https://client.test/callback",
    code_verifier: verifier,
    resource: RESOURCE
  }).access_token;
}

async function mcpPayload(response: Response): Promise<{
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
    readonly structuredContent?: Record<string, unknown>;
    readonly tools?: readonly { readonly name: string }[];
  };
  readonly error?: { readonly code?: number; readonly message?: string };
}> {
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : text;
  if (payload === undefined) throw new Error("Missing MCP payload");
  return JSON.parse(payload) as {
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      tools?: { name: string }[];
    };
    error?: { code?: number; message?: string };
  };
}

describe("surface profile and Debate integration", () => {
  it("resolves profile per OAuth grant on every exchange and keeps Debate/provider access in Gateway-only", async () => {
    const state = await temp("slnctrz-profile-state-");
    const project = await temp("slnctrz-profile-project-");
    const harness = await temp("slnctrz-profile-harness-");
    await ensureHarnessLayout(harness);
    await writeFile(join(project, "visible.txt"), "full-only file", "utf8");

    const grantStore = createSqliteOAuthGrantStore(join(state, "oauth-grants.sqlite3"));
    stores.push(grantStore);
    const oauth = new OAuthService({
      issuer: new URL("https://gateway.test"),
      resource: new URL(RESOURCE),
      ownerSecretHash: createOwnerSecretHash(OWNER_SECRET),
      grantStore
    });
    const client = oauth.registerClient({
      redirect_uris: ["https://client.test/callback"],
      token_endpoint_auth_method: "none"
    });
    const firstToken = issueGrant(oauth, client.client_id, "a".repeat(43));
    const secondToken = issueGrant(oauth, client.client_id, "b".repeat(43));
    const firstConnection = await oauth.authenticateConnection(firstToken);
    const secondConnection = await oauth.authenticateConnection(secondToken);
    expect(firstConnection.grantId).not.toBe(secondConnection.grantId);

    const providerCalls: unknown[] = [];
    const extensionRuntime: ExtensionRuntimeCatalog = {
      registry: await compileExtensionRegistry([]),
      isReady: () => true,
      acquire: () => () => undefined,
      retire: () => undefined,
      stop: async () => undefined,
      provider: () => ({
        state: "ready",
        start: async () => undefined,
        stop: async () => undefined,
        health: () => "ready",
        invoke: async (_name, args) => {
          providerCalls.push(args);
          return { isError: false, truncated: false, text: JSON.stringify(args) };
        }
      })
    };
    const kernelPolicy = {
      ...createKernelPolicySnapshot({
        workspaceId: "surface-profile",
        readRoots: [project],
        writeRoots: [project]
      }),
      extensionRuntime,
      extensions: [
        { canonicalId: "sample.echo", providerId: "sample", riskClass: "write" as const }
      ]
    };

    const debate = createDebateService(join(state, "debate.sqlite3"), {
      id: (() => {
        const ids = ["debate-1", "participant-1", "participant-2"];
        return () => ids.shift() ?? "unexpected-id";
      })()
    });
    debates.push(debate);

    const server = createGatewayServer({
      oauthService: oauth,
      kernelPolicy,
      harnessRuntime: new HarnessRuntime(harness),
      debateService: debate
    });
    servers.push(server);
    const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;
    let requestId = 0;
    const rpc = async (token: string, method: string, params: Record<string, unknown>) =>
      mcpPayload(
        await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18"
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params })
        })
      );

    const fullList = await rpc(firstToken, "tools/list", {});
    const fullNames = fullList.result?.tools?.map((tool) => tool.name) ?? [];
    expect(fullNames).toContain("core.read");
    expect(fullNames).toContain("context.bootstrap");
    expect(fullNames).toContain("sample.echo");
    expect(fullNames).toContain("debate.create");
    expect(fullNames).toContain("connection.restrict");

    const fullProviderWithoutHarness = await rpc(firstToken, "tools/call", {
      name: "sample.echo",
      arguments: { value: "full" }
    });
    expect(fullProviderWithoutHarness.result?.isError).toBe(true);
    expect(fullProviderWithoutHarness.result?.content?.[0]?.text).toContain("context_required");

    const restricted = await rpc(firstToken, "tools/call", {
      name: "connection.restrict",
      arguments: { profile: "gateway-only" }
    });
    expect(restricted.result?.isError).not.toBe(true);
    expect(restricted.result?.structuredContent).toMatchObject({
      connectionId: firstConnection.connectionId,
      surfaceProfile: "gateway-only"
    });

    const gatewayList = await rpc(firstToken, "tools/list", {});
    const gatewayNames = gatewayList.result?.tools?.map((tool) => tool.name) ?? [];
    expect(gatewayNames).toEqual(
      expect.arrayContaining([
        "core.ping",
        "connection.restrict",
        "debate.create",
        "debate.join",
        "debate.read",
        "debate.send",
        "debate.wait",
        "debate.stop",
        "sample.echo"
      ])
    );
    expect(gatewayNames).not.toContain("core.read");
    expect(gatewayNames).not.toContain("core.write");
    expect(gatewayNames.some((name) => name.startsWith("context."))).toBe(false);
    expect(gatewayNames.some((name) => name.startsWith("skills."))).toBe(false);
    expect(gatewayNames.some((name) => name.startsWith("task."))).toBe(false);

    const hiddenDirect = await rpc(firstToken, "tools/call", {
      name: "core.read",
      arguments: { path: "visible.txt" }
    });
    expect(hiddenDirect.result).toBeUndefined();
    expect(hiddenDirect.error).toBeDefined();

    const gatewayProvider = await rpc(firstToken, "tools/call", {
      name: "sample.echo",
      arguments: { value: "gateway" }
    });
    expect(gatewayProvider.result?.isError).not.toBe(true);
    expect(gatewayProvider.result?.structuredContent).toMatchObject({ value: "gateway" });
    expect(providerCalls).toContainEqual({ value: "gateway" });

    const ping = await rpc(firstToken, "tools/call", {
      name: "core.ping",
      arguments: {}
    });
    expect(ping.result?.structuredContent).toMatchObject({
      surfaceProfile: "gateway-only"
    });

    const created = await rpc(firstToken, "tools/call", {
      name: "debate.create",
      arguments: {
        topic: "Can two grants debate safely?",
        nickname: "Agent",
        maxTurns: 4,
        finalizerRole: "creator"
      }
    });
    expect(created.result?.isError).not.toBe(true);
    const createdBody = created.result?.structuredContent as
      | {
          debate?: { debateId?: string };
          membership?: { participantId?: string; membershipCredential?: string };
        }
      | undefined;
    const debateId = createdBody?.debate?.debateId;
    const creatorId = createdBody?.membership?.participantId;
    const creatorCredential = createdBody?.membership?.membershipCredential;
    expect(debateId).toBe("debate-1");
    expect(creatorId).toBe("participant-1");
    expect(typeof creatorCredential).toBe("string");

    const joined = await rpc(secondToken, "tools/call", {
      name: "debate.join",
      arguments: { debateId, nickname: "Agent" }
    });
    expect(joined.result?.isError).not.toBe(true);

    const wrongConnection = await rpc(secondToken, "tools/call", {
      name: "debate.read",
      arguments: {
        debateId,
        participantId: creatorId,
        membershipCredential: creatorCredential
      }
    });
    expect(wrongConnection.result?.isError).toBe(true);
    expect(wrongConnection.result?.content?.[0]?.text).toContain("membership_invalid");

    const correctConnection = await rpc(firstToken, "tools/call", {
      name: "debate.read",
      arguments: {
        debateId,
        participantId: creatorId,
        membershipCredential: creatorCredential
      }
    });
    expect(correctConnection.result?.isError).not.toBe(true);
    expect(correctConnection.result?.structuredContent).toMatchObject({
      debateId,
      currentParticipantId: creatorId
    });
    expect(typeof correctConnection.result?.structuredContent?.turnAcknowledgedAt).toBe("string");
  });
});
