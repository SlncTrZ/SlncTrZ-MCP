/** Managed Task Runner — authenticated HTTP/MCP end-to-end across independent requests. */

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

const TEST_RESOURCE = "https://mcp.example.com/mcp";
const OWNER_SECRET = "task-runner-e2e-owner";
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

function mcpHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
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
  const root = await mkdtemp(join(tmpdir(), "slnctrz-task-runner-"));
  cleanup.push(root);

  const oauth = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET)
  });
  const tokenA = authorizeClient(oauth, "client-a");
  const tokenB = authorizeClient(oauth, "client-b");

  const compiled = await compilePolicyDocument(
    { schemaVersion: 2, paths: [root] },
    compileCommandCatalog([["node"]])
  );
  const server = createGatewayServer({
    oauthService: oauth,
    activePolicy: buildActivePolicySnapshot(compiled),
    taskRuntime: createTaskRuntime()
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tokenA,
    tokenB
  };
}

async function rpc(
  origin: string,
  accessToken: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{
  result?: {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: Record<string, unknown>;
    tools?: { name?: string }[];
  };
  error?: { code?: number; message?: string };
}> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    ...(signal === undefined ? {} : { signal })
  });
  return (await readMcpPayload(response)) as {
    result?: {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      tools?: { name?: string }[];
    };
    error?: { code?: number; message?: string };
  };
}

async function callTask(
  origin: string,
  accessToken: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) {
  return rpc(origin, accessToken, id, "tools/call", { name, arguments: args }, signal);
}

describe("managed Task Runner HTTP/MCP", () => {
  it("advertises the additive Runner tools only when a gateway-lifetime runtime is enabled", async () => {
    const { origin, tokenA } = await runtime();
    const listed = await rpc(origin, tokenA, 1, "tools/list", {});

    const names = listed.result?.tools?.flatMap((tool) =>
      tool.name === undefined ? [] : [tool.name]
    );
    expect(names).toEqual(
      expect.arrayContaining(["core.exec", "task.start", "task.get", "task.wait", "task.cancel"])
    );
  });

  it("starts asynchronously, survives later requests, waits without cancelling, and completes", async () => {
    const { origin, tokenA } = await runtime();
    const started = await callTask(origin, tokenA, 2, "task.start", {
      command: "node",
      args: ["-e", "setTimeout(() => process.stdout.write('done'), 700)"],
      timeoutMs: 5_000
    });
    const taskId = String(started.result?.structuredContent?.taskId ?? "");
    expect(taskId).not.toBe("");
    expect(started.result?.structuredContent?.state).toBe("running");

    const timedWait = await callTask(origin, tokenA, 3, "task.wait", {
      taskId,
      timeoutMs: 20
    });
    expect(timedWait.result?.structuredContent).toMatchObject({
      taskId,
      state: "running",
      waitTimedOut: true
    });

    const current = await callTask(origin, tokenA, 4, "task.get", { taskId });
    expect(current.result?.structuredContent?.state).toBe("running");

    const completed = await callTask(origin, tokenA, 5, "task.wait", {
      taskId,
      timeoutMs: 2_000
    });
    expect(completed.result?.structuredContent).toMatchObject({
      taskId,
      state: "completed",
      waitTimedOut: false
    });
    expect(
      (
        completed.result?.structuredContent?.result as
          { stdout?: string; exitCode?: number } | undefined
      )?.stdout
    ).toBe("done");
    expect(
      (
        completed.result?.structuredContent?.result as
          { stdout?: string; exitCode?: number } | undefined
      )?.exitCode
    ).toBe(0);
  });

  it("aborting task.wait leaves the task running until explicit task.cancel", async () => {
    const { origin, tokenA } = await runtime();
    const started = await callTask(origin, tokenA, 6, "task.start", {
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000
    });
    const taskId = String(started.result?.structuredContent?.taskId ?? "");

    const controller = new AbortController();
    const wait = callTask(
      origin,
      tokenA,
      7,
      "task.wait",
      { taskId, timeoutMs: 2_000 },
      controller.signal
    );
    setTimeout(() => controller.abort(), 30);
    await expect(wait).rejects.toThrow();

    const current = await callTask(origin, tokenA, 8, "task.get", { taskId });
    expect(current.result?.structuredContent?.state).toBe("running");

    const cancelled = await callTask(origin, tokenA, 9, "task.cancel", { taskId });
    expect(cancelled.result?.structuredContent?.state).toBe("cancelled");
    expect(
      (cancelled.result?.structuredContent?.result as { cancelled?: boolean } | undefined)
        ?.cancelled
    ).toBe(true);
  });

  it("maps process timeout distinctly and keeps existing command policy authoritative", async () => {
    const { origin, tokenA } = await runtime();
    const started = await callTask(origin, tokenA, 10, "task.start", {
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50
    });
    const taskId = String(started.result?.structuredContent?.taskId ?? "");
    const timed = await callTask(origin, tokenA, 11, "task.wait", {
      taskId,
      timeoutMs: 2_000
    });
    expect(timed.result?.structuredContent?.state).toBe("timed_out");

    const denied = await callTask(origin, tokenA, 12, "task.start", {
      command: "git",
      args: ["status"]
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain("capability_denied");
  });

  it("does not let another authenticated client inspect or cancel the creator's task", async () => {
    const { origin, tokenA, tokenB } = await runtime();
    const started = await callTask(origin, tokenA, 13, "task.start", {
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000
    });
    const taskId = String(started.result?.structuredContent?.taskId ?? "");

    const foreignGet = await callTask(origin, tokenB, 14, "task.get", { taskId });
    expect(foreignGet.result?.isError).toBe(true);
    expect(foreignGet.result?.content?.[0]?.text).toContain("task_forbidden");

    const foreignCancel = await callTask(origin, tokenB, 15, "task.cancel", { taskId });
    expect(foreignCancel.result?.isError).toBe(true);
    expect(foreignCancel.result?.content?.[0]?.text).toContain("task_forbidden");

    const ownerCancel = await callTask(origin, tokenA, 16, "task.cancel", { taskId });
    expect(ownerCancel.result?.structuredContent?.state).toBe("cancelled");
  });
});
