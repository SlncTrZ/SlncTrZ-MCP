import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { createControlPlaneServer, listenControlPlane } from "../../src/control-plane/server.js";
import { createAuditJournal } from "../../src/observability/audit-journal.js";
import { createMetricsRegistry } from "../../src/observability/metrics.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";

const OWNER_SECRET = "phase-seven-owner-test-secret";
const OWNER_HASH = createOwnerSecretHash(OWNER_SECRET);
const servers: Server[] = [];

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

async function fixture(options: { telemetry?: boolean } = {}) {
  const snapshot = buildActivePolicySnapshot(
    await compilePolicyDocument({ schemaVersion: 1, workspaces: [] })
  );
  const reload = vi.fn(async () => ({
    activated: true,
    previousVersion: snapshot.version,
    activeVersion: snapshot.version,
    riskIncrease: false,
    result: "activated" as const
  }));
  const revokeClientByOwner = vi.fn(() => true);
  const revokeTokenByOwner = vi.fn(() => true);
  const recordRateLimit = vi.fn();
  const journal = createAuditJournal({ capacity: 100 });
  const metrics = options.telemetry === false ? undefined : createMetricsRegistry();
  const server = createControlPlaneServer({
    ownerSecretHash: OWNER_HASH,
    oauthService: { revokeClientByOwner, revokeTokenByOwner, recordRateLimit },
    policyStore: { capture: () => snapshot, reload },
    auditJournal: journal,
    ...(metrics === undefined ? {} : { metrics })
  });
  servers.push(server);
  const address = await listenControlPlane(server, { host: "127.0.0.1", port: 0 });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${OWNER_SECRET}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers
      }
    });
  return {
    journal,
    metrics,
    reload,
    request,
    revokeClientByOwner,
    revokeTokenByOwner
  };
}

describe("loopback control plane", () => {
  it("rejects non-loopback listeners before bind", async () => {
    const snapshot = buildActivePolicySnapshot(
      await compilePolicyDocument({ schemaVersion: 1, workspaces: [] })
    );
    const server = createControlPlaneServer({
      ownerSecretHash: OWNER_HASH,
      oauthService: {
        recordRateLimit: vi.fn(),
        revokeClientByOwner: vi.fn(),
        revokeTokenByOwner: vi.fn()
      },
      policyStore: {
        capture: () => snapshot,
        reload: vi.fn()
      },
      auditJournal: createAuditJournal({ capacity: 10 })
    });
    await expect(
      listenControlPlane(server, { host: "0.0.0.0" as "127.0.0.1", port: 0 })
    ).rejects.toThrow("loopback");
  });

  it("requires owner authentication and never reflects the supplied secret", async () => {
    const { request } = await fixture();
    const response = await request("/status", {
      headers: { authorization: "Bearer incorrect-owner-secret" }
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("incorrect-owner-secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("exports bounded status, metrics and privacy-reviewed audit events", async () => {
    const { request } = await fixture();
    const status = await request("/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      workspaceCount: 0,
      bindingCount: 0,
      extensions: []
    });

    const policy = await request("/policy");
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ workspaces: [] });

    const metrics = await request("/metrics");
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      requestActive: 0,
      toolCallsTotal: 0
    });

    const audit = await request("/audit?limit=10");
    expect(audit.status).toBe(200);
    const body = (await audit.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("reports telemetry disabled without breaking status", async () => {
    const { request } = await fixture({ telemetry: false });
    expect((await request("/status")).status).toBe(200);
    const response = await request("/metrics");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "telemetry_disabled" }
    });
  });

  it("owner-authorizes reload and redacts token material from the journal", async () => {
    const { journal, reload, request, revokeClientByOwner, revokeTokenByOwner } = await fixture();

    const reloadResponse = await request("/policy/reload", { method: "POST" });
    expect(reloadResponse.status).toBe(200);
    expect(reload).toHaveBeenCalledWith({ ownerApproved: true });

    const clientResponse = await request("/clients/revoke", {
      method: "POST",
      body: JSON.stringify({ clientId: "client-7" })
    });
    expect(clientResponse.status).toBe(200);
    expect(revokeClientByOwner).toHaveBeenCalledWith("client-7");

    const token = "sensitive-token-value-for-redaction-test";
    const tokenResponse = await request("/tokens/revoke", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    expect(tokenResponse.status).toBe(200);
    expect(revokeTokenByOwner).toHaveBeenCalledWith(token);
    expect(JSON.stringify(journal.export())).not.toContain(token);
  });

  it("rejects malformed, oversized and extra-field mutation bodies", async () => {
    const { request } = await fixture();
    const extra = await request("/clients/revoke", {
      method: "POST",
      body: JSON.stringify({ clientId: "client-7", unexpected: true })
    });
    expect(extra.status).toBe(400);

    const oversized = await request("/tokens/revoke", {
      method: "POST",
      body: JSON.stringify({ token: "x".repeat(70_000) })
    });
    expect(oversized.status).toBe(413);
  });
});
