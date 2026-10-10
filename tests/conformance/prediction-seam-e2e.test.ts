import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import type {
  ExtensionRuntimeCatalog,
  ExtensionProviderRuntime
} from "../../src/extension/runtime.js";
import { AdapterError } from "../../src/extension/adapter.js";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function fixture(failure?: "timeout" | "cancelled") {
  vi.stubEnv("SLNCTRZ_PREDICTION_SEAM_ENABLED", "true");
  const events: { name: string; args: unknown }[] = [];
  const provider = (invoke: ExtensionProviderRuntime["invoke"]): ExtensionProviderRuntime => ({
    state: "ready",
    start: async () => undefined,
    stop: async () => undefined,
    health: () => "ready",
    invoke
  });
  const brain = provider(async (name, args) => {
    events.push({ name, args });
    return { isError: false, truncated: false, text: JSON.stringify({ id: "prediction-fixture" }) };
  });
  const main = provider(async (name, args) => {
    events.push({ name, args });
    if (failure)
      throw new AdapterError(
        failure === "timeout" ? "provider_timeout" : "provider_unavailable",
        "fixture",
        failure
      );
    return { isError: false, truncated: false, text: JSON.stringify({ actual: true }) };
  });
  const runtime: ExtensionRuntimeCatalog = {
    registry: await compileExtensionRegistry([]),
    acquire: () => () => undefined,
    retire: () => undefined,
    stop: async () => undefined,
    isReady: () => true,
    provider: (id) => (id === "cyberbrain" ? brain : main)
  };
  const ownerFixture = "prediction seam test fixture";
  const oauth = new OAuthService({
    issuer: new URL("https://gateway.test"),
    resource: new URL("https://gateway.test/mcp"),
    ownerSecretHash: createOwnerSecretHash(ownerFixture)
  });
  const client = oauth.registerClient({
    redirect_uris: ["https://client.test/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "p".repeat(43);
  const transaction = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.test/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: "https://gateway.test/mcp",
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(
    transaction.transactionId,
    ownerFixture,
    "gateway-only"
  );
  const access = oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.test/callback",
    code_verifier: verifier,
    resource: "https://gateway.test/mcp"
  }).access_token;
  const server = createGatewayServer({
    oauthService: oauth,
    kernelPolicy: {
      ...createKernelPolicySnapshot({ workspaceId: "seam-fixture" }),
      extensionRuntime: runtime,
      extensions: [
        { canonicalId: "sample.mutate", providerId: "sample", riskClass: "write" as const }
      ]
    }
  });
  servers.push(server);
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return {
    events,
    call: async () => {
      const response = await fetch("http://127.0.0.1:" + address.port + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + access,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "sample.mutate", arguments: { value: "private-fixture-payload" } }
        })
      });
      const text = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
        : text;
      return JSON.parse(data ?? "{}") as {
        result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
      };
    }
  };
}

describe("Prediction Seam provider dispatch", () => {
  it("records before mutation, resolves after, and preserves actual structured content", async () => {
    const f = await fixture();
    const result = await f.call();
    expect(f.events.map((event) => event.name)).toEqual([
      "prediction_record",
      "mutate",
      "prediction_resolve"
    ]);
    expect(result.result?.structuredContent).toMatchObject({ actual: true });
    expect(JSON.stringify(f.events.filter((event) => event.name !== "mutate"))).not.toContain(
      "private-fixture-payload"
    );
  });
  it.each(["timeout", "cancelled"] as const)(
    "resolves a thrown provider %s honestly",
    async (failure) => {
      const f = await fixture(failure);
      const result = await f.call();
      expect(result.result?.isError).toBe(true);
      expect(f.events.map((event) => event.name)).toEqual([
        "prediction_record",
        "mutate",
        "prediction_resolve"
      ]);
      expect(f.events.at(-1)?.args).toMatchObject({ assessment: "indeterminate" });
    }
  );
});
