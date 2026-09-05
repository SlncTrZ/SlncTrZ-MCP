/** Logical Task Coordinator — authenticated multi-client HTTP/MCP end-to-end. */

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import { createTaskRuntime } from "../../src/task/runtime.js";

const TEST_RESOURCE = "https://mcp.example.com/mcp";
const OWNER_SECRET = "task-coordinator-e2e-owner";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
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

function mcpHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    connection: "close",
    "mcp-protocol-version": "2025-06-18"
  };
}

function authorizeClient(oauth: OAuthService, label: string): string {
  const client = oauth.registerClient({
    redirect_uris: [`https://${label}.example.com/callback`],
    token_endpoint_auth_method: "none"
  });
  const verifier = label.padEnd(43, "x").slice(0, 43);
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: `https://${label}.example.com/callback`,
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: TEST_RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER_SECRET);
  return oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: `https://${label}.example.com/callback`,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  }).access_token;
}

async function runtime() {
  const oauth = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET)
  });
  const tokenA = authorizeClient(oauth, "client-a");
  const tokenB = authorizeClient(oauth, "client-b");
  const tokenC = authorizeClient(oauth, "client-c");

  const server = createGatewayServer({
    oauthService: oauth,
    kernelPolicy: createKernelPolicySnapshot({ workspaceId: "coord-e2e" }),
    taskRuntime: createTaskRuntime()
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tokenA,
    tokenB,
    tokenC
  };
}

async function rpc(
  origin: string,
  accessToken: string,
  id: number,
  method: string,
  params: Record<string, unknown>
): Promise<{
  result?: {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: Record<string, unknown>;
    tools?: { name?: string }[];
  };
}> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return (await readMcpPayload(response)) as {
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      tools?: { name?: string }[];
    };
  };
}

function callTask(
  origin: string,
  accessToken: string,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  return rpc(origin, accessToken, id, "tools/call", { name, arguments: args });
}

describe("logical Task Coordinator HTTP/MCP", () => {
  it("advertises coordination tools without requiring core.exec authority", async () => {
    const { origin, tokenA } = await runtime();
    const listed = await rpc(origin, tokenA, 1, "tools/list", {});
    const names = listed.result?.tools?.flatMap((tool) =>
      tool.name === undefined ? [] : [tool.name]
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "task.create",
        "task.list",
        "task.get",
        "task.claim",
        "task.release",
        "task.complete",
        "task.fail",
        "task.cancel"
      ])
    );
    expect(names).not.toContain("task.start");
  });

  it("lets independent clients discover shared work and gives concurrent claim exactly one winner", async () => {
    const { origin, tokenA, tokenB, tokenC } = await runtime();
    const created = await callTask(origin, tokenA, 2, "task.create", {
      title: "Review implementation",
      instructions: "Inspect the implementation and return a concise result."
    });
    const taskId = String(created.result?.structuredContent?.taskId ?? "");
    expect(created.result?.structuredContent).toMatchObject({
      kind: "coordination",
      state: "available"
    });

    const listed = await callTask(origin, tokenB, 3, "task.list", {});
    const tasks = listed.result?.structuredContent?.tasks as
      { taskId?: string; state?: string }[] | undefined;
    expect(tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskId })]));

    const [claimB, claimC] = await Promise.all([
      callTask(origin, tokenB, 4, "task.claim", { taskId }),
      callTask(origin, tokenC, 5, "task.claim", { taskId })
    ]);
    const winners = [claimB, claimC].filter((result) => result.result?.isError !== true);
    const losers = [claimB, claimC].filter((result) => result.result?.isError === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.result?.content?.[0]?.text).toContain("task_already_claimed");

    const winnerToken = claimB.result?.isError !== true ? tokenB : tokenC;
    const loserToken = winnerToken === tokenB ? tokenC : tokenB;

    const forbidden = await callTask(origin, loserToken, 6, "task.complete", {
      taskId,
      result: "not mine"
    });
    expect(forbidden.result?.isError).toBe(true);
    expect(forbidden.result?.content?.[0]?.text).toContain("task_forbidden");

    const released = await callTask(origin, winnerToken, 7, "task.release", { taskId });
    expect(released.result?.structuredContent?.state).toBe("available");

    const reclaimed = await callTask(origin, loserToken, 8, "task.claim", { taskId });
    expect(reclaimed.result?.structuredContent).toMatchObject({
      state: "claimed"
    });

    const completed = await callTask(origin, loserToken, 9, "task.complete", {
      taskId,
      result: "review complete"
    });
    expect(completed.result?.structuredContent).toMatchObject({
      state: "completed",
      result: "review complete"
    });

    const creatorView = await callTask(origin, tokenA, 10, "task.get", { taskId });
    expect(creatorView.result?.structuredContent).toMatchObject({
      state: "completed",
      result: "review complete"
    });
  });

  it("supports claimant failure and creator cancellation while rejecting claimant cancellation", async () => {
    const { origin, tokenA, tokenB } = await runtime();

    const failedCreated = await callTask(origin, tokenA, 11, "task.create", {
      title: "Failure path",
      instructions: "Claim and report a blocker."
    });
    const failedId = String(failedCreated.result?.structuredContent?.taskId ?? "");
    await callTask(origin, tokenB, 12, "task.claim", { taskId: failedId });
    const failed = await callTask(origin, tokenB, 13, "task.fail", {
      taskId: failedId,
      failure: "blocked by missing dependency"
    });
    expect(failed.result?.structuredContent).toMatchObject({
      state: "failed",
      failure: "blocked by missing dependency"
    });

    const cancelCreated = await callTask(origin, tokenA, 14, "task.create", {
      title: "Cancellation path",
      instructions: "Creator may cancel even after this is claimed."
    });
    const cancelId = String(cancelCreated.result?.structuredContent?.taskId ?? "");
    await callTask(origin, tokenB, 15, "task.claim", { taskId: cancelId });

    const claimantCancel = await callTask(origin, tokenB, 16, "task.cancel", {
      taskId: cancelId
    });
    expect(claimantCancel.result?.isError).toBe(true);
    expect(claimantCancel.result?.content?.[0]?.text).toContain("task_forbidden");

    const creatorCancel = await callTask(origin, tokenA, 17, "task.cancel", {
      taskId: cancelId
    });
    expect(creatorCancel.result?.structuredContent).toMatchObject({
      state: "cancelled"
    });
  });
});
