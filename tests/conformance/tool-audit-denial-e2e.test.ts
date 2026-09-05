import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import { createAuditJournal } from "../../src/observability/audit-journal.js";
import { createSqliteAuditSink } from "../../src/observability/sqlite-audit.js";
import {
  createJournalToolAuditSink,
  type ToolAuditEvent
} from "../../src/observability/tool-audit.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { createTaskRuntime } from "../../src/task/runtime.js";

const RESOURCE = "https://mcp.example.com/mcp";
const OWNER = "audit-denial-owner";
const servers: Server[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function authorize(oauth: OAuthService, label: string): string {
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
    resource: RESOURCE,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER);
  return oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: `https://${label}.example.com/callback`,
    code_verifier: verifier,
    resource: RESOURCE
  }).access_token;
}

interface McpPayload {
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
}

async function payload(response: Response): Promise<McpPayload> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (data === undefined) throw new Error("missing SSE data");
    return JSON.parse(data) as McpPayload;
  }
  return JSON.parse(body) as McpPayload;
}

async function call(
  origin: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  return payload(
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args }
      })
    })
  );
}

describe("tool authorization audit semantics", () => {
  it("exports true authorization denials as denied while ordinary failures remain errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-audit-denial-"));
    cleanup.push(root);
    const sqlitePath = join(root, "audit.sqlite3");
    const sqlite = createSqliteAuditSink(sqlitePath);
    const journal = createAuditJournal({ capacity: 100, persist: (event) => sqlite.append(event) });
    const raw: ToolAuditEvent[] = [];
    const toolAudit = createJournalToolAuditSink(journal, (event) => raw.push(event));

    const oauth = new OAuthService({
      issuer: new URL("https://mcp.example.com"),
      resource: new URL(RESOURCE),
      ownerSecretHash: createOwnerSecretHash(OWNER)
    });
    const tokenA = authorize(oauth, "audit-a");
    const tokenB = authorize(oauth, "audit-b");
    const compiled = await compilePolicyDocument(
      { schemaVersion: 2, paths: [root] },
      compileCommandCatalog([["node"]])
    );
    const server = createGatewayServer({
      oauthService: oauth,
      activePolicy: buildActivePolicySnapshot(compiled),
      taskRuntime: createTaskRuntime(),
      toolAudit
    });
    servers.push(server);
    const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    expect(
      (await call(origin, tokenA, 1, "core.exec", { command: "git", args: ["status"] })).result
        ?.isError
    ).toBe(true);
    expect(
      (await call(origin, tokenA, 2, "task.start", { command: "git", args: ["status"] })).result
        ?.isError
    ).toBe(true);

    const started = await call(origin, tokenA, 3, "task.start", {
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000
    });
    const taskId = String(started.result?.structuredContent?.taskId ?? "");
    expect((await call(origin, tokenB, 4, "task.get", { taskId })).result?.isError).toBe(true);

    const created = await call(origin, tokenA, 5, "task.create", {
      title: "Claim",
      instructions: "Claim once"
    });
    const coordId = String(created.result?.structuredContent?.taskId ?? "");
    await call(origin, tokenA, 6, "task.claim", { taskId: coordId });
    expect((await call(origin, tokenB, 7, "task.claim", { taskId: coordId })).result?.isError).toBe(
      true
    );
    await call(origin, tokenA, 8, "task.cancel", { taskId });

    const deniedRaw = raw.filter(
      (event) =>
        ["core.exec", "task.start", "task.get"].includes(event.toolId) && event.decision === "deny"
    );
    expect(deniedRaw.map((event) => event.toolId).sort()).toEqual([
      "core.exec",
      "task.get",
      "task.start"
    ]);
    const contention = raw.find(
      (event) => event.toolId === "task.claim" && event.result === "error"
    );
    expect(contention).toMatchObject({ decision: "allow", result: "error" });

    const exported = journal.export();
    expect(
      exported
        .filter((event) => event.result === "denied")
        .map((event) => event.capabilityId)
        .sort()
    ).toEqual(["core.exec", "task.get", "task.start"]);
    expect(
      exported.some((event) => event.capabilityId === "task.claim" && event.result === "error")
    ).toBe(true);

    sqlite.close();
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT capability_id, result FROM audit_events WHERE capability_id IN ('core.exec','task.start','task.get','task.claim') ORDER BY id"
      )
      .all() as { capability_id: string; result: string }[];
    database.close();
    expect(rows.some((row) => row.capability_id === "core.exec" && row.result === "denied")).toBe(
      true
    );
    expect(rows.some((row) => row.capability_id === "task.start" && row.result === "denied")).toBe(
      true
    );
    expect(rows.some((row) => row.capability_id === "task.get" && row.result === "denied")).toBe(
      true
    );
    expect(rows.some((row) => row.capability_id === "task.claim" && row.result === "error")).toBe(
      true
    );
  });
});
