import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { HostTokenStore } from "../../src/auth/host-token-store.js";
import { bootstrap } from "../../src/app/main.js";
import type { RuntimeConfig } from "../../src/app/config.js";
import { listenControlPlane, type ControlListenAddress } from "../../src/control-plane/server.js";
import { listenGateway, type ListenAddress } from "../../src/app/http-server.js";
import { writeGatewayLifecycleIntent } from "../../src/observability/lifecycle-observability.js";
import { managedStatePaths } from "../../src/owner/managed-state.js";

const probeServers: ReturnType<typeof createServer>[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    probeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runtimeConfig(stateRoot: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    publicMcpUrl: new URL("https://mcp.example.test/mcp"),
    ownerSecretHash: createOwnerSecretHash("bootstrap test owner secret"),
    maxDynamicClients: 1,
    controlHost: "127.0.0.1",
    controlPort: 0,
    telemetryEnabled: false,
    ownerWebEnabled: false,
    allowedHostnames: ["localhost", "127.0.0.1"],
    allowedOriginHostnames: ["localhost", "127.0.0.1"],
    stateRoot
  };
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-bootstrap-"));
  cleanup.push(root);
  return root;
}

async function assertPortIsAvailable(address: ControlListenAddress | ListenAddress): Promise<void> {
  const probe = createServer();
  probeServers.push(probe);
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(address.port, address.host, () => resolve());
  });
}

describe("bootstrap lifecycle", () => {
  it("wires one persistent host store to control and MCP across application restarts", async () => {
    const root = await stateRoot();
    let controlAddress: ControlListenAddress | undefined;
    let gatewayAddress: ListenAddress | undefined;
    const config = runtimeConfig(root);
    const dependencies = {
      config,
      shutdownTimeoutMs: 1_000,
      listenControlPlane: async (
        server: Parameters<typeof listenControlPlane>[0],
        options: Parameters<typeof listenControlPlane>[1]
      ) => {
        controlAddress = await listenControlPlane(server, options);
        return controlAddress;
      },
      listenGateway: async (
        server: Parameters<typeof listenGateway>[0],
        options: Parameters<typeof listenGateway>[1]
      ) => {
        gatewayAddress = await listenGateway(server, options);
        return gatewayAddress;
      }
    };
    let lifecycle = await bootstrap(dependencies);
    let token = "";
    let tokenId = "";
    try {
      const secret = (await readFile(managedStatePaths(root).ownerPassphraseFile, "utf8")).trim();
      const issued = await fetch(`http://127.0.0.1:${controlAddress?.port}/host-tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ label: "restart client" })
      });
      expect(issued.status).toBe(201);
      const body = (await issued.json()) as { token: string; metadata: { tokenId: string } };
      token = body.token;
      tokenId = body.metadata.tokenId;
    } finally {
      await lifecycle.shutdown();
    }
    lifecycle = await bootstrap(dependencies);
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayAddress?.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("core.ping");
    } finally {
      await lifecycle.shutdown();
    }
    const store = new HostTokenStore(managedStatePaths(root).hostTokensDatabaseFile);
    try {
      expect(store.list()).toMatchObject([{ tokenId, label: "restart client" }]);
      expect(store.audit().map((e) => e.event)).toEqual(["issued", "used"]);
    } finally {
      store.close();
    }
  });
  it("closes the control listener when public gateway startup fails", async () => {
    let controlAddress: ControlListenAddress | undefined;
    await expect(
      bootstrap({
        config: runtimeConfig(await stateRoot()),
        listenControlPlane: async (server, options) => {
          controlAddress = await listenControlPlane(server, options);
          return controlAddress;
        },
        listenGateway: async () => {
          throw new Error("simulated gateway bind failure");
        }
      })
    ).rejects.toThrow("simulated gateway bind failure");

    expect(controlAddress).toBeDefined();
    await expect(
      assertPortIsAvailable(controlAddress as ControlListenAddress)
    ).resolves.toBeUndefined();
  });

  it("creates durable OAuth grant and Debate databases under stateRoot", async () => {
    const root = await stateRoot();
    const lifecycle = await bootstrap({
      config: runtimeConfig(root),
      shutdownTimeoutMs: 1_000
    });

    const oauthPath = join(root, "oauth-grants.sqlite3");
    const debatePath = join(root, "debate.sqlite3");
    expect((await stat(oauthPath)).isFile()).toBe(true);
    expect((await stat(debatePath)).isFile()).toBe(true);

    await lifecycle.shutdown();

    for (const [path, user_version] of [
      // Rotation history is additive; live credentials retain the v3 rollback contract.
      [oauthPath, 3],
      [debatePath, 1]
    ] as const) {
      const database = new DatabaseSync(path, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version });
      database.close();
    }
  });

  it("persists restart correlation and explicit shutdown reason without inventing one", async () => {
    const root = await stateRoot();
    const paths = managedStatePaths(root);
    await writeGatewayLifecycleIntent(paths.lifecycleIntentFile, "release_restart", {
      correlationId: () => "release-restart-1"
    });

    const lifecycle = await bootstrap({
      config: runtimeConfig(root),
      shutdownTimeoutMs: 1_000
    });
    await lifecycle.shutdown("SIGTERM");

    const database = new DatabaseSync(paths.auditDatabaseFile, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT capability_id, correlation_id, lifecycle_reason, result FROM audit_events WHERE category = 'lifecycle' ORDER BY id"
      )
      .all() as Record<string, unknown>[];
    database.close();

    expect(rows).toEqual([
      {
        capability_id: "gateway.startup",
        correlation_id: "release-restart-1",
        lifecycle_reason: "release_restart",
        result: "success"
      },
      {
        capability_id: "gateway.shutdown",
        correlation_id: null,
        lifecycle_reason: "SIGTERM",
        result: "success"
      }
    ]);
  });

  it("returns an idempotent shutdown handle that closes both listeners", async () => {
    let controlAddress: ControlListenAddress | undefined;
    let gatewayAddress: ListenAddress | undefined;
    const lifecycle = await bootstrap({
      config: runtimeConfig(await stateRoot()),
      shutdownTimeoutMs: 1_000,
      listenControlPlane: async (server, options) => {
        controlAddress = await listenControlPlane(server, options);
        return controlAddress;
      },
      listenGateway: async (server, options) => {
        gatewayAddress = await listenGateway(server, options);
        return gatewayAddress;
      }
    });

    expect(controlAddress).toBeDefined();
    expect(gatewayAddress).toBeDefined();
    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    expect(first).toBe(second);
    await first;

    await expect(
      assertPortIsAvailable(controlAddress as ControlListenAddress)
    ).resolves.toBeUndefined();
    await expect(assertPortIsAvailable(gatewayAddress as ListenAddress)).resolves.toBeUndefined();
  });
});
