import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostTokenStore, HOST_TOKEN_IDLE_SECONDS } from "../../src/auth/host-token-store.js";
import { authenticateHostToken } from "../../src/auth/host-token-auth.js";
import { OAuthService } from "../../src/auth/oauth-service.js";
import { createSqliteOAuthGrantStore } from "../../src/auth/oauth-grant-store.js";
import { OwnerConnectionService } from "../../src/auth/owner-connection-service.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createGatewayServer, listenGateway } from "../../src/app/http-server.js";
import { createControlPlaneServer, listenControlPlane } from "../../src/control-plane/server.js";
import { runStandaloneCli } from "../../src/app/standalone-cli.js";
import { createOwnerWebConsole } from "../../src/owner/web-console.js";
import { managedStatePaths } from "../../src/owner/managed-state.js";
import { createAuditJournal } from "../../src/observability/audit-journal.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import type { ExtensionRuntimeCatalog } from "../../src/extension/runtime.js";

const OWNER = "disposable host acceptance owner";
const RESOURCE = new URL("https://gateway.test/mcp");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(enableHostStore = true) {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-host-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new HostTokenStore(join(root, "hosts.sqlite3"));
  const grants = createSqliteOAuthGrantStore(join(root, "oauth.sqlite3"));
  cleanup.push(
    () => store.close(),
    () => grants.close()
  );
  const ownerSecretHash = createOwnerSecretHash(OWNER);
  const oauth = new OAuthService({
    issuer: new URL("https://gateway.test"),
    resource: RESOURCE,
    ownerSecretHash,
    grantStore: grants
  });
  const client = oauth.registerClient({
    redirect_uris: ["http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifier = "v".repeat(43);
  const pending = oauth.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:12345/callback",
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE.href,
    scope: "mcp:tools"
  });
  const redirect = oauth.approveAuthorization(pending.transactionId, OWNER, "full");
  const tokens = oauth.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:12345/callback",
    code_verifier: verifier,
    resource: RESOURCE.href,
    code: redirect.searchParams.get("code") ?? ""
  });
  const connections = new OwnerConnectionService(grants);
  connections.setClientDefault(client.client_id, "full");
  const compiled = await compilePolicyDocument({
    schemaVersion: 2,
    paths: [root],
    authorityMode: "autonomous"
  });
  const snapshot = buildActivePolicySnapshot(compiled);
  const policyStore = {
    capture: () => snapshot,
    reload: async () => ({
      activated: true as const,
      previousVersion: snapshot.version,
      activeVersion: snapshot.version,
      riskIncrease: false as const,
      result: "activated" as const
    })
  };
  const web = createOwnerWebConsole({
    ownerSecretHash,
    policyStore,
    statePaths: managedStatePaths(root),
    mutation: {
      apply: policyStore.reload,
      validate: async () => ({ valid: true as const, pathCount: 1 })
    },
    secureCookies: false,
    hostTokens: store,
    reloadClients: () => oauth.reloadClientsByOwner(),
    connections
  });
  const registry = await compileExtensionRegistry([]);
  const providerCalls: unknown[] = [];
  const extensionRuntime: ExtensionRuntimeCatalog = {
    registry,
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
    ...snapshot.normalized.kernelPolicy,
    extensionRuntime,
    extensions: [{ canonicalId: "sample.echo", providerId: "sample", riskClass: "read" as const }]
  };
  const errors: string[] = [];
  const gateway = createGatewayServer({
    oauthService: oauth,
    kernelPolicy,
    ownerWeb: web,
    ...(enableHostStore ? { hostTokens: store } : {}),
    onError: (e) => errors.push(e.message)
  });
  const control = createControlPlaneServer({
    ownerSecretHash,
    oauthService: oauth,
    policyStore,
    hostTokens: store,
    reloadClients: () => oauth.reloadClientsByOwner(),
    connections,
    auditJournal: createAuditJournal({ capacity: 100 })
  });
  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  cleanup.push(
    () => close(gateway),
    () => close(control)
  );
  const address = await listenGateway(gateway, { host: "127.0.0.1", port: 0 });
  const controlAddress = await listenControlPlane(control, { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const rpc = (token: string, method = "tools/list", params: unknown = {}) =>
    fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
  const payload = async (response: Response) => {
    const text = await response.text();
    const value = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
      : text;
    return JSON.parse(value ?? "null") as {
      result?: { tools?: { name: string }[]; isError?: boolean };
      error?: unknown;
    };
  };
  const login = async () => {
    const response = await fetch(origin + "/owner/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: OWNER })
    });
    const { csrf } = (await response.json()) as { csrf: string };
    return {
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
      "x-slnctrz-csrf": csrf,
      "content-type": "application/json"
    };
  };
  return {
    store,
    oauth,
    connections,
    tokens,
    origin,
    rpc,
    payload,
    login,
    providerCalls,
    errors,
    controlOrigin: `http://127.0.0.1:${controlAddress.port}`,
    controlPort: controlAddress.port
  };
}

describe("ADR-030 host bearer integration", () => {
  it("restricts client reload and health to Owner, requires CSRF and exposes the reload CLI", async () => {
    const f = await fixture();
    const host = f.store.issue("not Owner");
    for (const path of ["/owner/api/health", "/owner/api/clients/reload"]) {
      const method = path.endsWith("reload") ? "POST" : "GET";
      expect(
        (
          await fetch(f.origin + path, {
            method,
            headers: { authorization: `Bearer ${host.token}` }
          })
        ).status
      ).toBe(401);
    }
    const headers = await f.login();
    expect(
      (
        await fetch(f.origin + "/owner/api/clients/reload", {
          method: "POST",
          headers: { cookie: headers.cookie }
        })
      ).status
    ).toBe(403);
    const reloaded = await fetch(f.origin + "/owner/api/clients/reload", {
      method: "POST",
      headers
    });
    expect(reloaded.status).toBe(200);
    expect(await reloaded.json()).toMatchObject({ activated: true, dynamicClients: 1 });
    expect((await fetch(f.origin + "/owner/api/health", { headers })).status).toBe(200);
    const output: string[] = [];
    await runStandaloneCli(["owner", "clients-reload"], {
      environment: { SLNCTRZ_OWNER_SECRET: OWNER, SLNCTRZ_CONTROL_PORT: String(f.controlPort) },
      output: { write: (value) => output.push(value) }
    });
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ activated: true });
    expect((await f.rpc(f.tokens.access_token)).status).toBe(200);
    expect((await f.rpc(host.token)).status).toBe(200);
  });
  it("accepts host tokens with a hard authority ceiling on listing and dispatch; retains OAuth Full/PKCE/refresh", async () => {
    const f = await fixture();
    const host = f.store.issue("OpenCode");
    const connection = authenticateHostToken(f.store, host.token, RESOURCE).connection;
    expect(connection).toMatchObject({
      scopes: ["mcp:tools"],
      surfaceProfile: "gateway-only",
      clientId: `host:${host.metadata.tokenId}`
    });
    const listed = await f.rpc(host.token);
    expect(listed.status).toBe(200);
    const names = (await f.payload(listed)).result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("core.ping");
    expect(names).toContain("sample.echo");
    for (const hidden of [
      "core.read",
      "core.exec",
      "core.write",
      "context.bootstrap",
      "skills.read",
      "task.start",
      "connection.restrict"
    ]) {
      expect(names).not.toContain(hidden);
      const denied = await f.payload(
        await f.rpc(host.token, "tools/call", {
          name: hidden,
          arguments: { profile: "full", surfaceProfile: "full", scopes: ["owner"] }
        })
      );
      expect(denied.error !== undefined || denied.result?.isError === true).toBe(true);
    }
    const called = await f.payload(
      await f.rpc(host.token, "tools/call", {
        name: "sample.echo",
        arguments: { value: "fixture" }
      })
    );
    expect(called.result?.isError).not.toBe(true);
    expect(f.providerCalls).toHaveLength(1);
    const full = await f.payload(await f.rpc(f.tokens.access_token));
    expect(full.result?.tools?.map((t) => t.name)).toContain("core.read");
    const refreshed = f.oauth.exchangeRefreshToken({
      grant_type: "refresh_token",
      refresh_token: f.tokens.refresh_token,
      client_id: (await f.oauth.authenticateConnection(f.tokens.access_token)).clientId,
      resource: RESOURCE.href
    });
    expect((await f.rpc(refreshed.access_token)).status).toBe(200);
    expect(f.errors.join(" ")).not.toContain(host.token);
    expect(JSON.stringify(f.store.audit())).not.toContain(host.token);
  });

  it("fails closed for absent store, malformed, unknown, revoked, and idle credentials without OAuth fallback", async () => {
    const f = await fixture(false);
    const host = f.store.issue("no store");
    const verify = vi.spyOn(f.oauth, "verifyAccessToken");
    expect((await f.rpc(host.token)).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    expect((await f.rpc(f.tokens.access_token)).status).toBe(200);
    const g = await fixture();
    const unused = g.store.issue("unused", Math.floor(Date.now() / 1000) - HOST_TOKEN_IDLE_SECONDS);
    for (const token of ["hst_bad", "hst_" + "A".repeat(43), unused.token]) {
      const denied = await g.rpc(token);
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain(token);
    }
    expect(g.store.list()).toHaveLength(0);
    expect(g.store.audit().at(-1)?.event).toBe("inactive_15d");
    const active = g.store.issue("revoke");
    expect((await g.rpc(active.token)).status).toBe(200);
    g.store.revoke(active.metadata.tokenId);
    const requests = await Promise.all(Array.from({ length: 5 }, () => g.rpc(active.token)));
    expect(requests.every((r) => r.status === 401)).toBe(true);
  });

  it("Owner session + CSRF issues/lists/deletes, rejects escalation and never accepts host authority", async () => {
    const f = await fixture();
    const host = f.store.issue("attacker");
    const before = f.store.list()[0]?.lastUsedAt;
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await fetch(f.origin + "/owner/api/host-tokens", {
        method,
        headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ label: "unauthorized" }) })
      });
      expect(response.status).toBe(401);
    }
    expect(f.store.list()[0]?.lastUsedAt).toBe(before);
    const headers = await f.login();
    const csrfDenied = await fetch(f.origin + "/owner/api/host-tokens", {
      method: "POST",
      headers: { cookie: headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "csrf" })
    });
    expect(csrfDenied.status).toBe(403);
    for (const escalation of [
      { surfaceProfile: "full" },
      { scopes: ["owner"] },
      { expiresAt: 100 }
    ]) {
      const denied = await fetch(f.origin + "/owner/api/host-tokens", {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "bad", ...escalation })
      });
      expect(denied.status).toBe(400);
    }
    const issued = await fetch(f.origin + "/owner/api/host-tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Codex" })
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const created = (await issued.json()) as { token: string; metadata: { tokenId: string } };
    expect((await f.rpc(created.token)).status).toBe(200);
    const list = await fetch(f.origin + "/owner/api/host-tokens", { headers });
    expect(await list.text()).not.toContain(created.token);
    for (const expected of [true, false]) {
      const revoked = await fetch(f.origin + "/owner/api/host-tokens", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ tokenId: created.metadata.tokenId })
      });
      expect(await revoked.json()).toEqual({ revoked: expected });
    }
    expect((await f.rpc(created.token)).status).toBe(401);
    const page = await (await fetch(f.origin + "/owner")).text();
    expect(page).toContain('id="host-token-secret" type="password"');
    expect(page).toContain("clearHostSecret()");
    expect(page).not.toContain(created.token);
  });

  it("Owner CLI uses authenticated loopback management; host token cannot issue or revoke there", async () => {
    const f = await fixture();
    const host = f.store.issue("deny control");
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(
        (
          await fetch(f.controlOrigin + "/host-tokens", {
            method,
            headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
            ...(method === "GET" ? {} : { body: "{}" })
          })
        ).status
      ).toBe(401);
    }
    const output: string[] = [];
    const options = {
      environment: { SLNCTRZ_OWNER_SECRET: OWNER, SLNCTRZ_CONTROL_PORT: String(f.controlPort) },
      output: { write: (value: string) => output.push(value) }
    };
    expect(await runStandaloneCli(["owner", "host-token", "issue", "--label", "Pi"], options)).toBe(
      true
    );
    const issued = JSON.parse(output.pop() ?? "{}") as {
      token: string;
      metadata: { tokenId: string };
    };
    expect((await f.rpc(issued.token)).status).toBe(200);
    await runStandaloneCli(["owner", "host-token", "list"], options);
    expect(output.pop()).not.toContain(issued.token);
    await runStandaloneCli(["owner", "host-token", "delete", issued.metadata.tokenId], options);
    expect(output.pop()).toBe('{"revoked":true}');
    expect((await f.rpc(issued.token)).status).toBe(401);
    await expect(
      runStandaloneCli(
        ["owner", "host-token", "issue", "--label", "bad", "--expires", "90"],
        options
      )
    ).rejects.toThrow();
  });
});
