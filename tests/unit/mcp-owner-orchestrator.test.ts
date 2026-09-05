import { describe, expect, it, vi } from "vitest";
import type { ProviderCredential } from "../../src/extension/adapter.js";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import { createMcpOwnerOrchestrator } from "../../src/owner/mcp-owner-orchestrator.js";
import type { McpProviderService } from "../../src/owner/mcp-provider-service.js";
import type { ManagedMcpProvider } from "../../src/owner/mcp-provider-store.js";

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
    expect(result.completedSteps).toEqual(["provider_probed", "provider_saved"]);
  });

  it("preserves the prior credential when replacement probing fails", async () => {
    const oldRef = "demo-credential";
    const secrets = new Map<string, string>([[oldRef, "OLD"]]);
    const existing: ManagedMcpProvider = {
      id: "demo",
      enabled: true,
      manifest: { ...manifest, credentialRefs: [oldRef] },
      updatedAt: new Date(0).toISOString()
    };
    const service = providers({
      list: vi.fn(async () => [existing]),
      discoverCandidate: vi.fn(async () => {
        throw new Error("probe_failed");
      })
    });
    const removed: string[] = [];
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: {
        set: vi.fn(async (ref: string, credential: ProviderCredential) => {
          secrets.set(ref, credential.value);
          return { ref, kind: credential.kind };
        }),
        remove: vi.fn(async (ref) => {
          removed.push(ref);
          return secrets.delete(ref);
        })
      },
      providers: service
    });

    const result = await orchestrator.add({
      manifest,
      auth: { kind: "bearer", value: "NEW" }
    });
    expect(result.status).toBe("rolled_back");
    expect(result.recovery?.safeToRetry).toBe(true);
    expect(secrets.get(oldRef)).toBe("OLD");
    expect([...secrets.keys()]).toEqual([oldRef]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toBe(oldRef);
  });

  it("rotates authentication through a staged ref and preserves disabled state", async () => {
    const oldRef = "demo-credential";
    let current: ManagedMcpProvider = {
      id: "demo",
      enabled: false,
      manifest: { ...manifest, credentialRefs: [oldRef] },
      updatedAt: new Date(0).toISOString()
    };
    const secrets = new Map<string, string>([[oldRef, "OLD"]]);
    const discoverCandidate: McpProviderService["discoverCandidate"] = async (candidate) => ({
      providerId: "demo",
      declaredTools: candidate.tools.map((tool) => tool.canonicalId),
      discoveredTools: ["demo.echo"],
      matchesDeclaration: true
    });
    const addOrUpdate: McpProviderService["addOrUpdate"] = async (input) => {
      current = {
        id: "demo",
        enabled: input.enabled ?? true,
        manifest: input.manifest,
        updatedAt: new Date().toISOString()
      };
      return {
        provider: current,
        reload: {
          activated: true,
          previousVersion: "a",
          activeVersion: "b",
          riskIncrease: false,
          result: "activated"
        }
      };
    };
    const service = providers({
      list: vi.fn(async () => [current]),
      discoverCandidate: vi.fn(discoverCandidate),
      addOrUpdate: vi.fn(addOrUpdate)
    });
    const removed: string[] = [];
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: {
        set: vi.fn(async (ref: string, credential: ProviderCredential) => {
          secrets.set(ref, credential.value);
          return { ref, kind: credential.kind };
        }),
        remove: vi.fn(async (ref) => {
          removed.push(ref);
          return secrets.delete(ref);
        })
      },
      providers: service
    });

    const result = await orchestrator.updateAuth({
      providerId: "demo",
      auth: { kind: "bearer", value: "NEW" }
    });
    expect(result.status).toBe("committed");
    expect(current.enabled).toBe(false);
    const newRef = current.manifest.credentialRefs?.[0];
    expect(newRef).toBeDefined();
    expect(newRef).not.toBe(oldRef);
    expect(newRef?.length).toBeLessThanOrEqual(64);
    expect(secrets.get(newRef ?? "")).toBe("NEW");
    expect(secrets.has(oldRef)).toBe(false);
    expect(removed).toContain(oldRef);
  });

  it("rolls back a staged credential when activation fails", async () => {
    const oldRef = "demo-credential";
    const existing: ManagedMcpProvider = {
      id: "demo",
      enabled: true,
      manifest: { ...manifest, credentialRefs: [oldRef] },
      updatedAt: new Date(0).toISOString()
    };
    const secrets = new Map<string, string>([[oldRef, "OLD"]]);
    const discoverCandidate: McpProviderService["discoverCandidate"] = async () => ({
      providerId: "demo",
      declaredTools: [],
      discoveredTools: ["demo.echo"],
      matchesDeclaration: true
    });
    const addOrUpdate: McpProviderService["addOrUpdate"] = async () => ({
      provider: existing,
      reload: {
        activated: false,
        previousVersion: "a",
        activeVersion: "a",
        riskIncrease: false,
        result: "failed",
        failureCode: "policy_invalid"
      }
    });
    const service = providers({
      list: vi.fn(async () => [existing]),
      discoverCandidate: vi.fn(discoverCandidate),
      addOrUpdate: vi.fn(addOrUpdate)
    });
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: {
        set: vi.fn(async (ref: string, credential: ProviderCredential) => {
          secrets.set(ref, credential.value);
          return { ref, kind: credential.kind };
        }),
        remove: vi.fn(async (ref) => secrets.delete(ref))
      },
      providers: service
    });

    const result = await orchestrator.updateAuth({
      providerId: "demo",
      auth: { kind: "bearer", value: "NEW" }
    });
    expect(result.status).toBe("rolled_back");
    expect(result.recovery?.safeToRetry).toBe(true);
    expect(secrets).toEqual(new Map([[oldRef, "OLD"]]));
    expect(existing.manifest.credentialRefs).toEqual([oldRef]);
  });

  it("does not remove an old credential still referenced by another provider", async () => {
    const oldRef = "shared-credential";
    let current: ManagedMcpProvider = {
      id: "demo",
      enabled: true,
      manifest: { ...manifest, credentialRefs: [oldRef] },
      updatedAt: new Date(0).toISOString()
    };
    const other: ManagedMcpProvider = {
      id: "other",
      enabled: true,
      manifest: { ...manifest, id: "other", credentialRefs: [oldRef] },
      updatedAt: new Date(0).toISOString()
    };
    const addOrUpdate: McpProviderService["addOrUpdate"] = async (input) => {
      current = { ...current, manifest: input.manifest };
      return {
        provider: current,
        reload: {
          activated: true,
          previousVersion: "a",
          activeVersion: "b",
          riskIncrease: false,
          result: "activated"
        }
      };
    };
    const service = providers({
      list: vi.fn(async () => [current, other]),
      discoverCandidate: vi.fn(async () => ({
        providerId: "demo",
        declaredTools: ["demo.echo"],
        discoveredTools: ["demo.echo"],
        matchesDeclaration: true
      })),
      addOrUpdate: vi.fn(addOrUpdate)
    });
    const remove = vi.fn(async () => true);
    const orchestrator = createMcpOwnerOrchestrator({
      credentials: {
        set: vi.fn(async (ref: string, credential: ProviderCredential) => ({
          ref,
          kind: credential.kind,
          ...(credential.kind === "env" ? { name: credential.name } : {})
        })),
        remove
      },
      providers: service
    });

    expect(
      (
        await orchestrator.updateAuth({
          providerId: "demo",
          auth: { kind: "bearer", value: "NEW" }
        })
      ).status
    ).toBe("committed");
    expect(remove).not.toHaveBeenCalledWith(oldRef);
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
