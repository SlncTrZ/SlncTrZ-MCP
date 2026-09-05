import { describe, expect, it, vi } from "vitest";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import { createMcpOwnerOrchestrator } from "../../src/owner/mcp-owner-orchestrator.js";
import type { McpProviderService } from "../../src/owner/mcp-provider-service.js";

const manifest = {
  id: "demo",
  version: "1",
  transport: "streamable-http",
  endpoint: "https://example.com/mcp",
  tools: []
} as ExtensionManifestV1;

function providers(overrides: Partial<McpProviderService> = {}): McpProviderService {
  const addOrUpdate: McpProviderService["addOrUpdate"] = async (input) => ({
    provider: {
      id: input.manifest.id,
      enabled: input.enabled ?? true,
      manifest: input.manifest,
      updatedAt: new Date().toISOString()
    },
    reload: {
      activated: true,
      previousVersion: "a",
      activeVersion: "b",
      riskIncrease: false,
      result: "activated"
    }
  });
  return {
    list: vi.fn(async () => []),
    addOrUpdate: vi.fn(addOrUpdate),
    setEnabled: vi.fn(),
    remove: vi.fn(async () => ({
      removed: true,
      reload: {
        activated: true,
        previousVersion: "a",
        activeVersion: "b",
        riskIncrease: false,
        result: "activated"
      }
    })),
    discover: vi.fn(),
    discoverCandidate: vi.fn(async () => ({
      providerId: "demo",
      declaredTools: [],
      discoveredTools: ["demo.echo"],
      matchesDeclaration: false
    })),
    acceptToolSet: vi.fn(),
    toolDiff: vi.fn(),
    syncToDiscovered: vi.fn(),
    getDiscovered: vi.fn(),
    ...overrides
  } as McpProviderService;
}

describe("MCP owner orchestrator without workspace grants", () => {
  it("probes, persists and activates a provider without a workspace mutation", async () => {
    const service = providers();
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: { set: vi.fn(), remove: vi.fn() },
      providers: service
    });
    const result = await orchestrator.add({ manifest, enabled: true });
    expect(result.status).toBe("committed");
    expect(service.discoverCandidate).toHaveBeenCalledOnce();
    expect(service.addOrUpdate).toHaveBeenCalledOnce();
    expect(result.completedSteps).toEqual(["provider_saved"]);
  });

  it("removes a provider directly with no grant cleanup step", async () => {
    const service = providers();
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: { set: vi.fn(), remove: vi.fn() },
      providers: service
    });
    const result = await orchestrator.remove({ providerId: "demo" });
    expect(result.status).toBe("committed");
    expect(service.remove).toHaveBeenCalledWith("demo");
    expect(result.completedSteps).toEqual([]);
  });
});
