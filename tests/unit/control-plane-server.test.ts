import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createControlPlaneServer, listenControlPlane } from "../../src/control-plane/server.js";
import { createAuditJournal } from "../../src/observability/audit-journal.js";
import type { ActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import type { ReloadResult } from "../../src/policy/policy-store.js";

const servers: ReturnType<typeof createControlPlaneServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })
    )
  );
});

const secret = "control plane owner secret 123";

function snapshot(): ActivePolicySnapshot {
  return {
    version: "policy-v1",
    schemaVersion: 2,
    createdAt: new Date(0).toISOString(),
    hasWorkspaces: true,
    toolCatalogFingerprint: "catalog-v1",
    normalized: {
      schemaVersion: 2,
      kernelPolicy: {
        version: "kernel-v1",
        workspaceId: "default",
        authorityMode: "restricted",
        capabilities: ["core.read", "core.search"],
        readRoot: "/tmp",
        readRoots: ["/tmp"],
        writeRoot: "/tmp",
        writeRoots: ["/tmp"],
        runRoots: ["/tmp"],
        extensions: []
      },
      extensionRegistry: {
        extensions: [],
        toolIndex: {},
        hash: "extensions-v1",
        lookup() {
          return undefined;
        },
        lookupProvider() {
          return [];
        }
      }
    },
    resolve() {
      return this.normalized.kernelPolicy;
    }
  };
}

function activated(): ReloadResult {
  return {
    activated: true,
    previousVersion: "policy-v1",
    activeVersion: "policy-v2",
    riskIncrease: false,
    result: "activated"
  };
}

async function fixture() {
  const revokedClients: string[] = [];
  const revokedTokens: string[] = [];
  const server = createControlPlaneServer({
    ownerSecretHash: createOwnerSecretHash(secret),
    oauthService: {
      revokeClientByOwner(clientId) {
        revokedClients.push(clientId);
        return true;
      },
      revokeTokenByOwner(token) {
        revokedTokens.push(token);
        return true;
      }
    },
    policyStore: {
      capture: snapshot,
      async reload() {
        return activated();
      }
    },
    auditJournal: createAuditJournal({ capacity: 8 }),
    gatewayInfo: { version: "1.2.3", buildCommit: "abc123" }
  });
  servers.push(server);
  const address = await listenControlPlane(server, { host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, revokedClients, revokedTokens };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${secret}`, ...extra };
}

describe("control plane server", () => {
  it("requires owner authentication", async () => {
    const { origin } = await fixture();
    const response = await fetch(`${origin}/status`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("reports status/policy and activates reload", async () => {
    const { origin } = await fixture();
    const status = await fetch(`${origin}/status`, { headers: authHeaders() });
    expect(await status.json()).toEqual({
      status: "ok",
      policyVersion: "policy-v1",
      workspaceCount: 1,
      authorityMode: "restricted",
      version: "1.2.3",
      buildCommit: "abc123"
    });

    const policy = await fetch(`${origin}/policy`, { headers: authHeaders() });
    expect(await policy.json()).toMatchObject({
      policyVersion: "policy-v1",
      paths: ["/tmp"],
      capabilities: ["core.read", "core.search"]
    });

    const reload = await fetch(`${origin}/policy/reload`, {
      method: "POST",
      headers: authHeaders()
    });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ activated: true, activeVersion: "policy-v2" });
  });

  it("revokes clients/tokens and rejects malformed bodies", async () => {
    const { origin, revokedClients, revokedTokens } = await fixture();
    const client = await fetch(`${origin}/clients/revoke`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ clientId: "client-1" })
    });
    expect(client.status).toBe(200);
    expect(revokedClients).toEqual(["client-1"]);

    const token = await fetch(`${origin}/tokens/revoke`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ token: "token-1" })
    });
    expect(token.status).toBe(200);
    expect(revokedTokens).toEqual(["token-1"]);

    const malformed = await fetch(`${origin}/clients/revoke`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{"
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_json" } });
  });

  it("rejects non-loopback bind targets before listen", async () => {
    const server = createControlPlaneServer({
      ownerSecretHash: createOwnerSecretHash(secret),
      oauthService: { revokeClientByOwner: () => false, revokeTokenByOwner: () => false },
      policyStore: {
        capture: snapshot,
        async reload() {
          return activated();
        }
      },
      auditJournal: createAuditJournal({ capacity: 1 })
    });
    servers.push(server);
    await expect(
      listenControlPlane(server, { host: "0.0.0.0" as "127.0.0.1", port: 0 })
    ).rejects.toThrow("loopback");
  });
});
