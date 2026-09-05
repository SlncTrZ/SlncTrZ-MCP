import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { bootstrap } from "../../src/app/main.js";
import type { RuntimeConfig } from "../../src/app/config.js";
import { listenControlPlane, type ControlListenAddress } from "../../src/control-plane/server.js";

const probeServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    probeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        })
    )
  );
});

function runtimeConfig(): RuntimeConfig {
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
    allowedOriginHostnames: ["localhost", "127.0.0.1"]
  };
}

async function assertPortIsAvailable(address: ControlListenAddress): Promise<void> {
  const probe = createServer();
  probeServers.push(probe);
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(address.port, address.host, () => resolve());
  });
}

describe("bootstrap failure recovery", () => {
  it("closes the control listener when public gateway startup fails", async () => {
    let controlAddress: ControlListenAddress | undefined;
    await expect(
      bootstrap({
        config: runtimeConfig(),
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
});
