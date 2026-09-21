import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, type ApplicationLifecycle } from "../../src/app/main.js";
import type { RuntimeConfig } from "../../src/app/config.js";
import { listenGateway, type ListenAddress } from "../../src/app/http-server.js";
import { listenControlPlane } from "../../src/control-plane/server.js";

const RESOURCE = "https://gateway.test/mcp";
const OWNER_SECRET = "restart durability owner secret";
const cleanup: string[] = [];
const lifecycles: ApplicationLifecycle[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.shutdown()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(stateRoot: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    publicMcpUrl: new URL(RESOURCE),
    maxDynamicClients: 4,
    controlHost: "127.0.0.1",
    controlPort: 0,
    telemetryEnabled: false,
    ownerWebEnabled: false,
    allowedHostnames: ["127.0.0.1", "localhost"],
    allowedOriginHostnames: ["127.0.0.1", "localhost"],
    stateRoot
  };
}

async function start(
  stateRoot: string
): Promise<{ origin: string; lifecycle: ApplicationLifecycle }> {
  let gatewayAddress: ListenAddress | undefined;
  const lifecycle = await bootstrap({
    config: config(stateRoot),
    shutdownTimeoutMs: 1_000,
    listenControlPlane,
    listenGateway: async (server, options) => {
      gatewayAddress = await listenGateway(server, options);
      return gatewayAddress;
    }
  });
  lifecycles.push(lifecycle);
  if (gatewayAddress === undefined) throw new Error("gateway address missing");
  return { origin: `http://127.0.0.1:${gatewayAddress.port}`, lifecycle };
}

async function issueToken(origin: string): Promise<string> {
  const redirectUri = "https://restart-client.test/callback";
  const registration = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none"
    })
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };
  const verifier = "r".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/authorize", origin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "mcp:tools"
  }).toString();

  const consent = await fetch(authorize);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const transactionId = html.match(/name="transaction_id" value="([^"]+)"/u)?.[1];
  if (transactionId === undefined) throw new Error("authorization transaction missing");

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
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: RESOURCE
    })
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

interface McpReply {
  readonly result?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
    readonly structuredContent?: Record<string, unknown>;
    readonly tools?: readonly { readonly name: string }[];
  };
  readonly error?: unknown;
}

async function rpc(
  origin: string,
  token: string,
  id: number,
  method: string,
  params: Record<string, unknown>
): Promise<McpReply> {
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
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
    : text;
  if (payload === undefined) throw new Error("missing MCP payload");
  return JSON.parse(payload) as McpReply;
}

describe("v0.3.3 application restart durability", () => {
  it("preserves OAuth grant profile and Debate membership across gateway restart", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "slnctrz-v033-restart-"));
    cleanup.push(stateRoot);
    await mkdir(join(stateRoot, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(stateRoot, "secrets", "owner-passphrase"), `${OWNER_SECRET}\n`, {
      mode: 0o600
    });

    const first = await start(stateRoot);
    const token = await issueToken(first.origin);

    const restricted = await rpc(first.origin, token, 1, "tools/call", {
      name: "connection.restrict",
      arguments: { profile: "gateway-only" }
    });
    expect(restricted.result?.isError).not.toBe(true);
    expect(restricted.result?.structuredContent?.surfaceProfile).toBe("gateway-only");

    const created = await rpc(first.origin, token, 2, "tools/call", {
      name: "debate.create",
      arguments: {
        topic: "Does restart preserve this debate?",
        nickname: "RestartAgent",
        maxTurns: 4,
        finalizerRole: "creator"
      }
    });
    expect(created.result?.isError).not.toBe(true);
    const debate = created.result?.structuredContent as
      | {
          debate?: { debateId?: string };
          membership?: { participantId?: string; membershipCredential?: string };
        }
      | undefined;
    const debateId = debate?.debate?.debateId;
    const participantId = debate?.membership?.participantId;
    const membershipCredential = debate?.membership?.membershipCredential;
    expect(typeof debateId).toBe("string");
    expect(typeof participantId).toBe("string");
    expect(typeof membershipCredential).toBe("string");

    await first.lifecycle.shutdown();
    lifecycles.splice(lifecycles.indexOf(first.lifecycle), 1);

    const second = await start(stateRoot);
    const listed = await rpc(second.origin, token, 3, "tools/list", {});
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("debate.read");
    expect(names).toContain("connection.restrict");
    expect(names).not.toContain("core.read");
    expect(names.some((name) => name.startsWith("context."))).toBe(false);

    const read = await rpc(second.origin, token, 4, "tools/call", {
      name: "debate.read",
      arguments: { debateId, participantId, membershipCredential }
    });
    expect(read.result?.isError).not.toBe(true);
    expect(read.result?.structuredContent).toMatchObject({
      debateId,
      currentParticipantId: null
    });
  });
});
