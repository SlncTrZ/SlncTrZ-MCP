import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import { HarnessRuntime } from "../../src/context/runtime.js";
import { ensureHarnessLayout } from "../../src/context/provisioning.js";
import { createTaskRuntime, type TaskRuntime } from "../../src/task/runtime.js";
import { CONTEXT_META_KEY } from "../../src/protocol/harness-tools.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import type { ExtensionRuntimeCatalog } from "../../src/extension/runtime.js";
import type { ToolAuditEvent } from "../../src/observability/tool-audit.js";

const servers: Server[] = [],
  directories: string[] = [],
  tasks: TaskRuntime[] = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.shutdown()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "harness-http-"));
  directories.push(path);
  return path;
}
function issueToken(oauth: OAuthService) {
  const client = oauth.registerClient({
    redirect_uris: ["https://client.test/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "t".repeat(43);
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.test/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: "https://gateway.test/mcp",
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, "harness test owner secret");
  return oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.test/callback",
    code_verifier: verifier,
    resource: "https://gateway.test/mcp"
  }).access_token;
}
interface ToolReply {
  result: {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
    content: { type: string; text?: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    instructions?: string;
  };
  error?: unknown;
}
async function start(withProvider = false) {
  const global = await temp(),
    project = await temp();
  await ensureHarnessLayout(global);
  await writeFile(join(project, "counter.txt"), "");
  const oauth = new OAuthService({
    issuer: new URL("https://gateway.test"),
    resource: new URL("https://gateway.test/mcp"),
    ownerSecretHash: createOwnerSecretHash("harness test owner secret")
  });
  const accessToken = issueToken(oauth),
    otherToken = issueToken(oauth);
  const audit: ToolAuditEvent[] = [],
    taskRuntime = createTaskRuntime();
  tasks.push(taskRuntime);
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
  const server = createGatewayServer({
    oauthService: oauth,
    harnessRuntime: new HarnessRuntime(global),
    taskRuntime,
    toolAudit: (event) => {
      audit.push(event);
    },
    kernelPolicy: {
      ...createKernelPolicySnapshot({
        workspaceId: "harness",
        readRoots: [project],
        writeRoots: [project],
        runRoots: [project],
        commandCatalog: compileCommandCatalog([["node", "-e"]])
      }),
      ...(withProvider
        ? {
            extensionRuntime,
            extensions: [
              { canonicalId: "sample.echo", providerId: "sample", riskClass: "write" as const }
            ]
          }
        : {})
    }
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  let id = 0;
  async function rpc(
    method: string,
    params: Record<string, unknown>,
    modern = false,
    token = accessToken,
    context?: string
  ): Promise<ToolReply> {
    const meta = {
      ...(modern
        ? {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "coding-harness-client", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        : {}),
      ...(context === undefined ? {} : { [CONTEXT_META_KEY]: context })
    };
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": modern ? "2026-07-28" : "2025-06-18",
        ...(modern
          ? {
              "mcp-method": method,
              ...(typeof params.name === "string" ? { "mcp-name": params.name } : {})
            }
          : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } })
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim()
      : text;
    if (payload === undefined) throw new Error("Missing MCP response");
    return JSON.parse(payload) as ToolReply;
  }
  return { global, project, rpc, accessToken, otherToken, audit, providerCalls };
}

describe.each([false, true])("harness through authenticated MCP (modern=%s)", (modern) => {
  it("delivers catalog, instructions and a referenced resource through separate calls", async () => {
    const g = await start();
    const list = await g.rpc("tools/list", {}, modern);
    expect(list.result.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["context.bootstrap", "context.close", "skills.list", "skills.read"])
    );
    const toolAnnotations = new Map(
      list.result.tools?.map((tool) => [tool.name, tool.annotations?.readOnlyHint])
    );
    expect(toolAnnotations.get("context.bootstrap")).toBe(false);
    expect(toolAnnotations.get("context.close")).toBe(false);
    expect(toolAnnotations.get("skills.list")).toBe(true);
    expect(toolAnnotations.get("skills.read")).toBe(false);
    const boot = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} }, modern);
    expect(boot.error).toBeUndefined();
    const token = String(boot.result.structuredContent.contextToken);
    expect(boot.result.structuredContent.catalog).toHaveLength(2);
    expect(JSON.stringify(boot)).not.toContain("# Diagnose and verify a defect");
    const activation = await g.rpc(
      "tools/call",
      { name: "skills.read", arguments: { name: "debug-and-test", slnctrzContext: token } },
      modern
    );
    expect(activation.result.structuredContent.content).toContain("# Diagnose and verify a defect");
    expect(activation.result.structuredContent.content).not.toContain(
      "# Choosing regression evidence"
    );
    const resource = await g.rpc(
      "tools/call",
      {
        name: "skills.read",
        arguments: {
          name: "debug-and-test",
          resource: "references/regression-checks.md",
          slnctrzContext: token
        }
      },
      modern
    );
    expect(resource.result.structuredContent.content).toContain("# Choosing regression evidence");
    // The context reader must not turn the global root into general filesystem authority.
    const denied = await g.rpc(
      "tools/call",
      {
        name: "core.read",
        arguments: { path: join(g.global, "AGENTS.md"), slnctrzContext: token }
      },
      modern
    );
    expect(denied.result.isError).toBe(true);
  });

  it("blocks execution before bootstrap and stale retries do not duplicate side effects", async () => {
    const g = await start();
    const operation = {
      command: "node",
      args: ["-e", "require('node:fs').appendFileSync('counter.txt', 'x')"],
      root: g.project
    };
    const rejected = await g.rpc("tools/call", { name: "core.exec", arguments: operation }, modern);
    expect(rejected.result.structuredContent).toMatchObject({
      error: { code: "context_required" },
      operationExecuted: false
    });
    expect(await readFile(join(g.project, "counter.txt"), "utf8")).toBe("");
    const boot = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} }, modern);
    const token = String(boot.result.structuredContent.contextToken);
    const ran = await g.rpc(
      "tools/call",
      { name: "core.exec", arguments: operation },
      modern,
      g.accessToken,
      token
    );
    expect(ran.result.structuredContent.exitCode).toBe(0);
    await writeFile(join(g.global, "AGENTS.md"), "UPDATED-INSTRUCTIONS");
    const stale = await g.rpc(
      "tools/call",
      { name: "core.exec", arguments: { ...operation, slnctrzContext: token } },
      modern
    );
    expect(stale.result.structuredContent).toMatchObject({
      error: { code: "context_stale" },
      operationExecuted: false
    });
    expect(await readFile(join(g.project, "counter.txt"), "utf8")).toBe("x");
    const fresh = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} }, modern);
    const retry = await g.rpc(
      "tools/call",
      {
        name: "core.exec",
        arguments: { ...operation, slnctrzContext: fresh.result.structuredContent.contextToken }
      },
      modern
    );
    expect(retry.result.structuredContent.exitCode).toBe(0);
    expect(await readFile(join(g.project, "counter.txt"), "utf8")).toBe("xx");
    expect(
      g.audit.filter((event) => event.toolId === "core.exec").map((event) => event.result)
    ).toEqual(["error", "success", "error", "success"]);
  });

  it("guards file, media and task tools and refuses another authenticated client's receipt", async () => {
    const g = await start();
    for (const [name, args] of [
      ["core.read", { path: "counter.txt" }],
      ["core.search", { pattern: "*" }],
      ["core.write", { path: "new.txt", content: "MUST-NOT-WRITE" }],
      [
        "core.edit",
        {
          path: "counter.txt",
          expectedSha256: "0".repeat(64),
          edits: [{ oldText: "a", newText: "b" }]
        }
      ],
      ["media.read_image", { path: "image.png" }],
      ["task.start", { command: "node", args: ["-e", "process.exit(0)"] }],
      ["task.create", { title: "task", instructions: "work" }],
      ["task.list", {}],
      ["task.get", { taskId: "unknown" }],
      ["task.wait", { taskId: "unknown" }],
      ["task.claim", { taskId: "unknown" }],
      ["task.release", { taskId: "unknown" }],
      ["task.complete", { taskId: "unknown", result: "done" }],
      ["task.fail", { taskId: "unknown", failure: "failed" }]
    ] as const) {
      const reply = await g.rpc("tools/call", { name, arguments: args }, modern);
      expect(reply.result.structuredContent, name).toMatchObject({
        error: { code: "context_required" },
        operationExecuted: false
      });
    }
    await expect(readFile(join(g.project, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const boot = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} }, modern);
    const token = String(boot.result.structuredContent.contextToken);
    const other = await g.rpc(
      "tools/call",
      { name: "core.read", arguments: { path: "counter.txt", slnctrzContext: token } },
      modern,
      g.otherToken
    );
    expect(other.result.structuredContent).toMatchObject({ error: { code: "context_required" } });
    const own = await g.rpc(
      "tools/call",
      { name: "core.read", arguments: { path: "counter.txt", slnctrzContext: token } },
      modern
    );
    expect(own.result.isError).not.toBe(true);
  });
});

it("gates upstream provider dispatch and strips the receipt from provider arguments", async () => {
  const g = await start(true);
  const denied = await g.rpc("tools/call", { name: "sample.echo", arguments: { value: "test" } });
  expect(denied.result.structuredContent).toMatchObject({ error: { code: "context_required" } });
  expect(g.providerCalls).toEqual([]);
  const boot = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} });
  const reply = await g.rpc("tools/call", {
    name: "sample.echo",
    arguments: { value: "test", slnctrzContext: boot.result.structuredContent.contextToken }
  });
  expect(reply.result.isError).not.toBe(true);
  expect(g.providerCalls).toEqual([{ value: "test" }]);
});

it("permits owned task cancellation when instructions become unreadable", async () => {
  const g = await start();
  const boot = await g.rpc("tools/call", { name: "context.bootstrap", arguments: {} });
  const started = await g.rpc("tools/call", {
    name: "task.start",
    arguments: {
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      root: g.project,
      slnctrzContext: boot.result.structuredContent.contextToken
    }
  });
  const taskId = started.result.structuredContent.taskId;
  expect(typeof taskId).toBe("string");
  await writeFile(join(g.global, "AGENTS.md"), Buffer.from([0xff]));
  const denied = await g.rpc(
    "tools/call",
    { name: "task.cancel", arguments: { taskId } },
    false,
    g.otherToken
  );
  expect(denied.result.isError).toBe(true);
  const cancelled = await g.rpc("tools/call", { name: "task.cancel", arguments: { taskId } });
  expect(cancelled.result.isError).not.toBe(true);
  expect(cancelled.result.structuredContent.state).toBe("cancelled");
});
