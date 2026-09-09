import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { KernelPolicyInput } from "../../src/policy/kernel-policy.js";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import { extractCanonicalAgentHarness } from "../../src/shared/agent-harness.js";

const servers: Server[] = [];
const directories: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64"
);
async function temp() {
  const p = await mkdtemp(join(tmpdir(), "slnctrz-image-"));
  directories.push(p);
  return p;
}
const TEST_OWNER_SECRET = "conformance test owner secret";
const TEST_RESOURCE = "https://mcp.example.com/mcp";
const TEST_AGENT_HARNESS = extractCanonicalAgentHarness(
  [
    "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->",
    "## Test harness",
    "- Read before you write.",
    "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->"
  ].join("\n")
);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
});

async function startGateway(
  policy: Partial<KernelPolicyInput> = {}
): Promise<{ origin: string; accessToken: string }> {
  const oauthService = new OAuthService({
    issuer: new URL("https://mcp.example.com"),
    resource: new URL(TEST_RESOURCE),
    ownerSecretHash: createOwnerSecretHash(TEST_OWNER_SECRET)
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
  const redirect = oauthService.approveAuthorization(pending.transactionId, TEST_OWNER_SECRET);
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
    kernelPolicy: createKernelPolicySnapshot({ workspaceId: "conformance", ...policy }),
    gatewayInfo: {
      version: "test",
      config: {
        policy: "/state/policy.json",
        commands: "/state/command.json",
        providers: "/state/mcp/providers.json"
      },
      docs: [],
      agentHarness: TEST_AGENT_HARNESS
    }
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return { origin: `http://127.0.0.1:${address.port}`, accessToken: tokens.access_token };
}

async function readMcpPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (data === undefined) throw new Error("MCP SSE response has no data frame");
    return JSON.parse(data);
  }
  return JSON.parse(body);
}

async function rpc(
  gateway: { origin: string; accessToken: string },
  method: string,
  params: object
) {
  const response = await fetch(gateway.origin + "/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + gateway.accessToken,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  expect(response.status).toBe(200);
  return (await readMcpPayload(response)) as {
    result?: {
      tools?: { name: string }[];
      isError?: boolean;
      content?: { type: string; data?: string; text?: string; mimeType?: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: unknown;
  };
}

describe("media.read_image over authenticated MCP", () => {
  it("transports exact PNG bytes from a second root with metadata and display guidance", async () => {
    const first = await temp(),
      second = await temp();
    const path = join(second, "misleading.jpg");
    await writeFile(path, png);
    const gateway = await startGateway({ readRoots: [first, second] });
    const listed = await rpc(gateway, "tools/list", {});
    expect(listed.result?.tools?.map((t) => t.name)).toContain("media.read_image");
    const ping = await rpc(gateway, "tools/call", { name: "core.ping", arguments: {} });
    expect(ping.result?.structuredContent?.media).toMatchObject({
      advertisedTools: ["media.read_image"],
      images: {
        available: true,
        requiredCapability: "core.read",
        maxBytes: 4 * 1_048_576,
        maxPixels: 25_000_000,
        displayRequiresClientSupport: true
      }
    });
    expect(ping.result?.content?.[0]?.text).toContain("final answer");
    const reply = await rpc(gateway, "tools/call", {
      name: "media.read_image",
      arguments: { path }
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).not.toBe(true);
    expect(reply.result?.content?.[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: png.toString("base64")
    });
    expect(reply.result?.structuredContent).toMatchObject({
      width: 1,
      height: 1,
      bytes: png.length,
      transformed: false,
      sha256: createHash("sha256").update(png).digest("hex")
    });
    expect(reply.result?.structuredContent).not.toHaveProperty("data");
    expect(reply.result?.content?.[1]?.text).toContain("final answer");
  });

  it("does not advertise or allow image reads without read authority", async () => {
    const gateway = await startGateway();
    const listed = await rpc(gateway, "tools/list", {});
    expect(listed.result?.tools?.map((t) => t.name)).not.toContain("media.read_image");
    const ping = await rpc(gateway, "tools/call", { name: "core.ping", arguments: {} });
    expect(ping.result?.structuredContent?.media).toMatchObject({
      advertisedTools: [],
      images: { available: false }
    });
    const reply = await rpc(gateway, "tools/call", {
      name: "media.read_image",
      arguments: { path: "/etc/passwd" }
    });
    expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
  });

  it("enforces documentation scope, traversal and symlink containment", async () => {
    const root = await temp(),
      outside = await temp();
    await writeFile(join(root, "image.png"), png);
    await writeFile(join(outside, "image.png"), png);
    const docs = await startGateway({ readRoot: root, readAllowlist: ["docs/**"] });
    const denied = await rpc(docs, "tools/call", {
      name: "media.read_image",
      arguments: { path: "image.png" }
    });
    expect(denied.result?.isError).toBe(true);
    const gateway = await startGateway({ readRoot: root });
    await symlink(join(outside, "image.png"), join(root, "escape.png"));
    for (const path of [join(outside, "image.png"), "escape.png", "../image.png"]) {
      const reply = await rpc(gateway, "tools/call", {
        name: "media.read_image",
        arguments: { path }
      });
      expect(reply.result?.isError).toBe(true);
      expect(reply.result?.content?.some((c) => c.type === "image")).not.toBe(true);
    }
  });

  it("rejects malformed input and preserves autonomous absolute-path access", async () => {
    const root = await temp();
    await writeFile(join(root, "bad.png"), "not an image");
    await writeFile(join(root, "image.png"), png);
    const gateway = await startGateway({ authorityMode: "autonomous" });
    const good = await rpc(gateway, "tools/call", {
      name: "media.read_image",
      arguments: { path: join(root, "image.png") }
    });
    expect(good.result?.content?.[0]?.type).toBe("image");
    const bad = await rpc(gateway, "tools/call", {
      name: "media.read_image",
      arguments: { path: join(root, "bad.png") }
    });
    expect(bad.result?.isError).toBe(true);
  });
});

it.skipIf(!process.env.SLNCTRZ_IMAGE_SMOKE_PATH)(
  "reads the owner's supplied image through isolated authenticated MCP",
  async () => {
    const path = process.env.SLNCTRZ_IMAGE_SMOKE_PATH;
    if (!path) throw new Error("SLNCTRZ_IMAGE_SMOKE_PATH is required");
    const original = await readFile(path);
    const gateway = await startGateway({ readRoot: dirname(path) });
    const reply = await rpc(gateway, "tools/call", {
      name: "media.read_image",
      arguments: { path }
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).not.toBe(true);
    const block = reply.result?.content?.find((c) => c.type === "image");
    expect(block?.data).toBe(original.toString("base64"));
    expect(reply.result?.structuredContent?.sha256).toBe(
      createHash("sha256").update(original).digest("hex")
    );
  }
);
