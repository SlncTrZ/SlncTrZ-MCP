import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import { createMcpProviderService } from "../../src/owner/mcp-provider-service.js";
import {
  createMcpProviderStore,
  type ManagedMcpProvider,
  type McpProviderStore
} from "../../src/owner/mcp-provider-store.js";

const manifest = {
  id: "demo",
  version: "1",
  transport: "streamable-http",
  endpoint: "https://example.com/mcp",
  tools: [{ canonicalId: "demo.echo", riskClass: "network" }]
} as ExtensionManifestV1;

function provider(enabled = true): ManagedMcpProvider {
  return { id: "demo", enabled, manifest, updatedAt: new Date(0).toISOString() };
}

describe("MCP provider enabled-state authority", () => {
  it("persists enabled state then activates runtime without workspace grant lookup", async () => {
    let current = provider(false);
    const upsert: McpProviderStore["upsert"] = async (input) => {
      current = {
        ...current,
        enabled: input.enabled ?? current.enabled,
        manifest: input.manifest
      };
      return current;
    };
    const store: McpProviderStore = {
      list: vi.fn(async () => [current]),
      get: vi.fn(async () => current),
      upsert: vi.fn(upsert),
      remove: vi.fn(async () => true)
    };
    const reload = vi.fn(async () => ({
      activated: true as const,
      previousVersion: "a",
      activeVersion: "b",
      riskIncrease: false as const,
      result: "activated" as const
    }));
    const service = createMcpProviderService({ store, policyStore: { reload } });
    const result = await service.setEnabled("demo", true);
    expect(result.provider?.enabled).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("removes a provider directly and reloads without checking grants", async () => {
    const store: McpProviderStore = {
      list: vi.fn(async () => [provider()]),
      get: vi.fn(async () => provider()),
      upsert: vi.fn(async () => provider()),
      remove: vi.fn(async () => true)
    };
    const reload = vi.fn(async () => ({
      activated: true as const,
      previousVersion: "a",
      activeVersion: "b",
      riskIncrease: false as const,
      result: "activated" as const
    }));
    const service = createMcpProviderService({ store, policyStore: { reload } });
    const result = await service.remove("demo");
    expect(result.removed).toBe(true);
    expect(store.remove).toHaveBeenCalledWith("demo");
  });

  it("serializes persist-reload-rollback transactions across concurrent mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-provider-service-race-"));
    try {
      const store = createMcpProviderStore(join(root, "providers.json"));
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      let reloadCount = 0;
      const service = createMcpProviderService({
        store,
        policyStore: {
          async reload() {
            reloadCount += 1;
            if (reloadCount === 1) await firstGate;
            if (reloadCount === 1) {
              return {
                activated: false,
                previousVersion: "a",
                activeVersion: "a",
                riskIncrease: false,
                result: "failed",
                failureCode: "policy_invalid"
              } as const;
            }
            return {
              activated: true,
              previousVersion: "a",
              activeVersion: "b",
              riskIncrease: false,
              result: "activated"
            } as const;
          }
        }
      });
      const firstManifest = { ...manifest, id: "first" } as ExtensionManifestV1;
      const secondManifest = { ...manifest, id: "second" } as ExtensionManifestV1;
      const first = service.addOrUpdate({ manifest: firstManifest });
      while (reloadCount === 0)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      const second = service.addOrUpdate({ manifest: secondManifest });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(reloadCount).toBe(1);

      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.reload.activated).toBe(false);
      expect(secondResult.reload.activated).toBe(true);
      expect(reloadCount).toBe(2);
      expect((await store.list()).map((entry) => entry.id)).toEqual(["second"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores durable provider state when activation reload throws", async () => {
    let current = provider(false);
    const store: McpProviderStore = {
      list: vi.fn(async () => [current]),
      get: vi.fn(async () => current),
      upsert: vi.fn(async (input) => {
        current = {
          ...current,
          manifest: input.manifest,
          enabled: input.enabled ?? current.enabled
        };
        return current;
      }),
      remove: vi.fn(async () => true)
    };
    const service = createMcpProviderService({
      store,
      policyStore: {
        async reload() {
          throw new Error("reload_boom");
        }
      }
    });

    await expect(service.setEnabled("demo", true)).rejects.toThrow("reload_boom");
    expect(current.enabled).toBe(false);
  });

  it("namespaces bare discovered tool ids under the provider when persisting", async () => {
    let persisted: ExtensionManifestV1 | undefined;
    const upsert: McpProviderStore["upsert"] = async (input) => {
      persisted = input.manifest;
      return {
        id: "demo",
        enabled: input.enabled ?? true,
        manifest: input.manifest,
        updatedAt: new Date(0).toISOString()
      };
    };
    const store: McpProviderStore = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      upsert: vi.fn(upsert),
      remove: vi.fn(async () => true)
    };
    const reload = vi.fn(async () => ({
      activated: true as const,
      previousVersion: "a",
      activeVersion: "b",
      riskIncrease: false as const,
      result: "activated" as const
    }));
    const service = createMcpProviderService({ store, policyStore: { reload } });
    await service.addOrUpdate({
      manifest: {
        id: "demo",
        version: "1",
        transport: "streamable-http",
        endpoint: "http://127.0.0.1:3003/mcp",
        tools: [
          { canonicalId: "run_pipeline", riskClass: "network" },
          { canonicalId: "demo.already_ns", riskClass: "network" }
        ]
      } as ExtensionManifestV1
    });
    expect(persisted?.tools.map((t) => t.canonicalId)).toEqual([
      "demo.run_pipeline",
      "demo.already_ns"
    ]);
  });
});
