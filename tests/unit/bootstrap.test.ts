import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { bootstrap } from "../../src/app/main.js";
import type { RuntimeConfig } from "../../src/app/config.js";
import { listenControlPlane, type ControlListenAddress } from "../../src/control-plane/server.js";
import { listenGateway, type ListenAddress } from "../../src/app/http-server.js";

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
