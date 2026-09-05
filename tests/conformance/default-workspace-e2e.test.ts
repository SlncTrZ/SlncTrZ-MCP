/**
 * Fresh-install default-workspace acceptance — HTTP/MCP end-to-end.
 * Wing: conformance | Topic: default-workspace | Updated: 2026-08-30
 *
 * Verifies the product contract (commit 84d78ab): a fresh install seeds one explicit
 * full-authority `default` workspace; any authenticated client resolves straight to it
 * with no bootstrap/read-only ceremony, no mandatory binding/profile/proposal, and no
 * AGENTS.md mandate. Write/edit apply in the default path (dryRun: false), and a stale
 * bootstrap selector never demotes the default workspace.
 *
 * Platform note: core.exec is platform-native and is expected on Windows and POSIX when a
 * command catalog is configured.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createMetricsRegistry } from "../../src/observability/metrics.js";
import {
  DEFAULT_WORKSPACE_CAPABILITIES,
  initializeDefaultWorkspace,
  loadCommandCatalog,
  managedStatePaths
} from "../../src/owner/managed-state.js";
import { compilePolicyDocument, loadPolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";

const TEST_RESOURCE = "https://mcp.example.com/mcp";
const OWNER_SECRET = "acceptance-default-workspace-owner";
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

function mcpHeaders(
  accessToken: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    ...extra
  };
}

/** Expected default-workspace capability surface for the current platform. */
function expectedCapabilities(): string[] {
  return [...DEFAULT_WORKSPACE_CAPABILITIES];
}

async function freshRuntime(
  options: { readonly authorityMode?: "restricted" | "autonomous" } = {}
) {
  const appRoot = await mkdtemp(join(tmpdir(), "slnctrz-accept-app-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "slnctrz-accept-state-"));
  cleanup.push(appRoot, stateRoot);
  await mkdir(join(appRoot, "docs"), { recursive: true });
  await writeFile(join(appRoot, "README.md"), "# Acceptance app\n", "utf8");

  // Fresh install: seed the full-authority default workspace via the real initializer.
  const paths = managedStatePaths(stateRoot);
  await initializeDefaultWorkspace({ paths, root: appRoot });

  // Provide the platform command catalog so loadCommandCatalog surfaces core.exec.
  await mkdir(join(appRoot, "config"), { recursive: true });
  await writeFile(
    join(appRoot, "config", process.platform === "win32" ? "commands.win32.json" : "commands.json"),
    JSON.stringify({
      shell: {
        allowlist: {
          added:
            process.platform === "win32" ? ["node", "npm", "npx"] : ["node", "sh", "bash", "git"]
        }
      }
    }),
    "utf8"
  );
  const catalog = await loadCommandCatalog(paths, appRoot);
  const document = await loadPolicyDocument(paths.policyFile);
  const compiled = await compilePolicyDocument(
    {
      ...document,
      ...(options.authorityMode === undefined ? {} : { authorityMode: options.authorityMode })
    },
    catalog
  );
  const activePolicy = buildActivePolicySnapshot(compiled);

  const oauthService = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(OWNER_SECRET)
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
  const redirect = oauthService.approveAuthorization(pending.transactionId, OWNER_SECRET);
  const tokens = oauthService.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.example.com/callback",
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });

  const server = createGatewayServer({
    oauthService,
    activePolicy,
    metrics: createMetricsRegistry()
  });
  servers.push(server);
  const addr = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    accessToken: tokens.access_token,
    appRoot,
    document
  };
}

async function rpc(
  origin: string,
  accessToken: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = mcpHeaders(accessToken)
) {
  return (await readMcpPayload(
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    })
  )) as { result?: Record<string, unknown>; error?: { code?: number; message?: string } };
}

async function listToolNames(
  origin: string,
  accessToken: string,
  id: number,
  headers?: Record<string, string>
): Promise<string[]> {
  const payload = await rpc(
    origin,
    accessToken,
    id,
    "tools/list",
    {},
    headers === undefined ? mcpHeaders(accessToken) : headers
  );
  const tools = ((payload as { result?: { tools?: { name?: string }[] } }).result?.tools ?? []).map(
    (tool) => tool.name
  );
  return tools.filter((name): name is string => name !== undefined);
}

describe("fresh-install default workspace is immediately full authority", () => {
  it("(1) seeds only schema-v2 shared Paths state", async () => {
    const { document } = await freshRuntime();
    expect(document.schemaVersion).toBe(2);
    expect(document.paths).toEqual([expect.any(String)]);
    expect("workspaces" in document).toBe(false);
    expect("clientBindings" in document).toBe(false);
    expect("fallbackWorkspaceId" in document).toBe(false);
  });

  it("(2) core.ping reports the workspace and directs the model to read the workspace docs", async () => {
    const { origin, accessToken } = await freshRuntime();
    const init = await rpc(origin, accessToken, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1.0.0" }
    });
    expect(init.error).toBeUndefined();

    const ping = await rpc(origin, accessToken, 2, "tools/call", {
      name: "core.ping",
      arguments: {}
    });
    expect(ping.error).toBeUndefined();
    const result = ping.result as {
      content?: { text?: string }[];
      structuredContent?: {
        status?: string;
        workspace?: { capabilities?: string[] };
        extensions?: {
          configuredProviders?: number;
          readyProviders?: number;
          advertisedTools?: number;
          catalogFingerprint?: string;
        };
      };
    };
    expect(result.content?.[0]?.text).toContain("SlncTrZ-MCP gateway is online");
    expect(result.content?.[0]?.text).toContain("docs/MODEL_GUIDE.md");
    expect(result.content?.[0]?.text).toContain("workspace docs");
    expect(result.content?.[0]?.text).not.toContain("NaN");
    expect(result.structuredContent?.status).toBe("ok");
    expect(result.structuredContent?.workspace?.capabilities).toEqual(expectedCapabilities());
    expect(result.structuredContent?.extensions).toMatchObject({
      configuredProviders: 0,
      readyProviders: 0,
      advertisedTools: 0
    });
    expect(result.structuredContent?.extensions?.catalogFingerprint).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("(3) tools/list exposes the core capability tools; an unbound client resolves to default", async () => {
    const { origin, accessToken } = await freshRuntime();
    const tools = await listToolNames(origin, accessToken, 3);
    const caps = expectedCapabilities();
    expect(tools).toContain("core.ping");
    for (const cap of caps) expect(tools).toContain(cap);
    expect(tools).toContain("core.exec");
    expect(tools.length).toBe(caps.length + 1);
  });

  it("(4) core.write and core.edit apply in the default path; core.read scopes to it", async () => {
    const { origin, accessToken } = await freshRuntime();
    const write = await rpc(origin, accessToken, 4, "tools/call", {
      name: "core.write",
      arguments: { path: "docs/acceptance.txt", content: "hello acceptance" }
    });
    const writeResult = write.result as { isError?: boolean };
    expect(writeResult.isError).not.toBe(true);

    const read = await rpc(origin, accessToken, 5, "tools/call", {
      name: "core.read",
      arguments: { path: "docs/acceptance.txt" }
    });
    const readResult = read.result as {
      isError?: boolean;
      content?: { text?: string }[];
      structuredContent?: { sha256?: string };
    };
    expect(readResult.isError).not.toBe(true);
    expect(readResult.content?.[0]?.text).toContain("hello acceptance");
    const readSha = readResult.structuredContent?.sha256;
    expect(readSha).toMatch(/^[a-f0-9]{64}$/u);

    const edit = await rpc(origin, accessToken, 6, "tools/call", {
      name: "core.edit",
      arguments: {
        path: "docs/acceptance.txt",
        expectedSha256: readSha,
        edits: [{ oldText: "hello acceptance", newText: "hello edited" }]
      }
    });
    const editResult = edit.result as { isError?: boolean; content?: { text?: string }[] };
    expect(editResult.isError).not.toBe(true);
    expect(editResult.content?.[0]?.text).toContain("edit applied");

    const reread = await rpc(origin, accessToken, 7, "tools/call", {
      name: "core.read",
      arguments: { path: "docs/acceptance.txt" }
    });
    expect((reread.result as { content?: { text?: string }[] }).content?.[0]?.text).toContain(
      "hello edited"
    );
  });

  it("(5) autonomous mode operates outside workspace Paths with user authority", async () => {
    const outside = await mkdtemp(join(tmpdir(), "slnctrz-autonomous-outside-"));
    cleanup.push(outside);
    const secretPath = join(outside, ".env");
    await writeFile(secretPath, "AUTONOMOUS=1\n", "utf8");
    const { origin, accessToken } = await freshRuntime({ authorityMode: "autonomous" });

    const read = await rpc(origin, accessToken, 20, "tools/call", {
      name: "core.read",
      arguments: { path: secretPath }
    });
    expect((read.result as { isError?: boolean }).isError).not.toBe(true);
    expect((read.result as { content?: { text?: string }[] }).content?.[0]?.text).toContain(
      "AUTONOMOUS=1"
    );

    const writePath = join(outside, "created.txt");
    const write = await rpc(origin, accessToken, 21, "tools/call", {
      name: "core.write",
      arguments: { path: writePath, content: "outside workspace" }
    });
    expect((write.result as { isError?: boolean }).isError).not.toBe(true);

    const search = await rpc(origin, accessToken, 22, "tools/call", {
      name: "core.search",
      arguments: { root: outside, pattern: "created.txt" }
    });
    expect(
      (search.result as { structuredContent?: { matches?: string[] } }).structuredContent?.matches
    ).toContain("created.txt");

    const exec = await rpc(origin, accessToken, 23, "tools/call", {
      name: "core.exec",
      arguments: { command: process.execPath, args: ["--version"], root: outside }
    });
    expect((exec.result as { isError?: boolean }).isError).not.toBe(true);
    expect(
      String(
        (exec.result as { structuredContent?: { stdout?: string } }).structuredContent?.stdout ?? ""
      )
    ).toMatch(/^v\d+/u);
  });

  it("(6) legacy workspace/profile selector headers have no authority", async () => {
    const { origin, accessToken } = await freshRuntime();
    const tools = await listToolNames(
      origin,
      accessToken,
      8,
      mcpHeaders(accessToken, {
        "x-slnctrz-workspace": "anything",
        "x-slnctrz-profile": "anything"
      })
    );
    expect(tools).toContain("core.write");
    expect(tools).toContain("core.edit");
    expect(tools).toContain("core.ping");
  });
});
