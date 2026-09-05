import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  deriveProviderStatus,
  diffProviderTools,
  projectDiscoveredTools,
  projectProviderDetail,
  discoverRiskClass
} from "../../src/owner/mcp-presentation.js";
import type { ManagedMcpProvider } from "../../src/owner/mcp-provider-store.js";
import type { McpCredentialMetadata } from "../../src/owner/mcp-credential-store.js";

function provider(overrides: Partial<ManagedMcpProvider>): ManagedMcpProvider {
  return {
    id: "github",
    name: "GitHub",
    enabled: true,
    updatedAt: "2026-08-30T00:00:00.000Z",
    manifest: {
      id: "github",
      transport: "streamable-http",
      version: "1.0.0",
      endpoint: "https://github.example.com/mcp",
      tools: [{ canonicalId: "github.list", riskClass: "read" }]
    },
    ...overrides
  };
}

describe("deriveProviderStatus", () => {
  it("prioritizes disabled over runtime and drift", () => {
    expect(
      deriveProviderStatus({
        enabled: false,
        runtime: { state: "ready", health: "ready" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("disabled");
  });

  it("prioritizes auth required over drift and runtime", () => {
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "ready", health: "ready" },
        credentialMissing: true,
        toolDrift: true
      })
    ).toBe("auth_required");
  });

  it("maps drift to needs_sync", () => {
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "ready", health: "ready" },
        credentialMissing: false,
        toolDrift: true
      })
    ).toBe("needs_sync");
  });

  it("maps supervisor states to the product vocabulary", () => {
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "ready", health: "ready" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("ready");
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "restarting", health: "unavailable" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("restarting");
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "starting", health: "unavailable" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("connecting");
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "quarantined", health: "unavailable" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("unavailable");
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: { state: "failed", health: "unavailable" },
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("unavailable");
  });

  it("returns unavailable when there is no runtime signal", () => {
    expect(
      deriveProviderStatus({
        enabled: true,
        runtime: undefined,
        credentialMissing: false,
        toolDrift: false
      })
    ).toBe("unavailable");
  });
});

describe("classifyProviderFailure", () => {
  it("maps a missing credential to auth_required", () => {
    expect(classifyProviderFailure(true, true)).toBe("auth_required");
    expect(classifyProviderFailure(true, false)).toBe("auth_required");
  });

  it("does not map a generic runtime failure to auth_required", () => {
    expect(classifyProviderFailure(false, true)).toBe("provider_unavailable");
    expect(classifyProviderFailure(false, false)).toBe("connection_failed");
  });
});

describe("projectProviderDetail", () => {
  const runtime = { state: "ready" as const, health: "ready" as const };

  it("projects an enabled, ready remote provider without leaking secrets", () => {
    const detail = projectProviderDetail({
      provider: provider({}),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: false
    });
    expect(detail.status).toBe("ready");
    expect(detail.enabled).toBe(true);
    expect(detail.connection.kind).toBe("remote");
    expect(detail.connection.endpoint).toBe("https://github.example.com/mcp");
    expect(detail.auth.kind).toBe("none");
    expect(detail.tools.acceptedCount).toBe(1);
    expect(detail.workspace.granted).toBe(true);
    expect(detail.workspace.mode).toBe("all");
    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(JSON.stringify(detail)).not.toContain("Bearer");
  });

  it("projects a disabled provider as Disabled and preserves config", () => {
    const detail = projectProviderDetail({
      provider: provider({ enabled: false }),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: false
    });
    expect(detail.status).toBe("disabled");
    expect(detail.enabled).toBe(false);
  });

  it("reports auth_required when an expected credential is missing", () => {
    const detail = projectProviderDetail({
      provider: provider({
        manifest: {
          id: "github",
          transport: "streamable-http",
          version: "1.0.0",
          endpoint: "https://github.example.com/mcp",
          credentialRefs: ["github-token"],
          tools: [{ canonicalId: "github.list", riskClass: "read" }]
        }
      }),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: false
    });
    expect(detail.status).toBe("auth_required");
  });

  it("reports a configured header credential without the value", () => {
    const credentials: McpCredentialMetadata[] = [
      { ref: "github-token", kind: "http-header", name: "X-API-Key" }
    ];
    const detail = projectProviderDetail({
      provider: provider({
        manifest: {
          id: "github",
          transport: "streamable-http",
          version: "1.0.0",
          endpoint: "https://github.example.com/mcp",
          credentialRefs: ["github-token"],
          tools: [{ canonicalId: "github.list", riskClass: "read" }]
        }
      }),
      runtime,
      credentials,
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: false
    });
    expect(detail.status).toBe("ready");
    expect(detail.auth.kind).toBe("header");
    expect(detail.auth.configured).toBe(true);
    expect(detail.auth.name).toBe("X-API-Key");
    expect(detail.auth.ref).toBe("github-token");
    expect(JSON.stringify(detail)).not.toMatch(/secret-token|api-key-value/i);
  });

  it("distinguishes all-tools from subset grants", () => {
    const allDetail = projectProviderDetail({
      provider: provider({}),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: false
    });
    expect(allDetail.workspace.mode).toBe("all");
    expect(allDetail.workspace.toolIds).toBeUndefined();

    const subsetDetail = projectProviderDetail({
      provider: provider({}),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      grantToolIds: ["github.list"],
      toolDrift: false
    });
    expect(subsetDetail.workspace.mode).toBe("subset");
    expect(subsetDetail.workspace.toolIds).toEqual(["github.list"]);
  });

  it("surfaces tool drift as needs_sync and highlights it in tools", () => {
    const detail = projectProviderDetail({
      provider: provider({}),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: true,
      discoveredCount: 3
    });
    expect(detail.status).toBe("needs_sync");
    expect(detail.tools.needsSync).toBe(true);
    expect(detail.tools.discoveredCount).toBe(3);
  });

  it("projects health metadata from a cached discovery snapshot", () => {
    const detail = projectProviderDetail({
      provider: provider({}),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: true,
      toolDrift: true,
      discoveredCount: 3,
      discoveredAt: "2026-08-30T10:00:00.000Z"
    });
    expect(detail.health).toEqual({
      status: "needs_sync",
      lastProbeAt: "2026-08-30T10:00:00.000Z",
      needsSync: true
    });
  });

  it("projects a local (stdio) provider connection", () => {
    const detail = projectProviderDetail({
      provider: provider({
        manifest: {
          id: "local",
          transport: "stdio",
          version: "1.0.0",
          command: "/usr/bin/node",
          args: ["-y", "@vendor/server"],
          tools: [{ canonicalId: "local.ping", riskClass: "read" }]
        }
      }),
      runtime,
      credentials: [],
      workspaceId: "default",
      workspaceGranted: false,
      toolDrift: false
    });
    expect(detail.connection.kind).toBe("local");
    expect(detail.connection.command).toBe("/usr/bin/node");
    expect(detail.connection.args).toEqual(["-y", "@vendor/server"]);
    expect(detail.workspace.granted).toBe(false);
  });
});

describe("discoverRiskClass", () => {
  it("returns execute for a stdio provider", () => {
    expect(discoverRiskClass("stdio")).toBe("execute");
  });

  it("returns network for a streamable-http provider", () => {
    expect(discoverRiskClass("streamable-http")).toBe("network");
  });
});

describe("projectDiscoveredTools", () => {
  const accepted = [{ canonicalId: "svc.ping", riskClass: "read" } as const];

  it("reuses the registered risk class for a retained tool", () => {
    const projected = projectDiscoveredTools("svc", accepted, ["svc.ping"], "streamable-http");
    expect(projected).toEqual([{ canonicalId: "svc.ping", riskClass: "read" }]);
  });

  it("assigns a conservative transport risk class to a new tool", () => {
    const projected = projectDiscoveredTools(
      "svc",
      accepted,
      ["svc.alpha", "svc.beta"],
      "streamable-http"
    );
    expect(projected).toEqual([
      { canonicalId: "svc.alpha", riskClass: "network" },
      { canonicalId: "svc.beta", riskClass: "network" }
    ]);
  });

  it("never invents an elevated risk for a stdio new tool", () => {
    const projected = projectDiscoveredTools("svc", accepted, ["svc.exec"], "stdio");
    expect(projected[0]?.riskClass).toBe("execute");
  });

  it("namespaces bare discovered ids under the provider for a clean diff", () => {
    // A server reports bare names (ping); the projection must carry the provider namespace so
    // the accepted-vs-discovered diff (needs_sync) compares like-for-like and stays clean.
    const projected = projectDiscoveredTools("svc", accepted, ["ping", "alpha"], "streamable-http");
    expect(projected).toEqual([
      { canonicalId: "svc.ping", riskClass: "read" },
      { canonicalId: "svc.alpha", riskClass: "network" }
    ]);
  });
});

describe("diffProviderTools", () => {
  const a = { canonicalId: "svc.alpha", riskClass: "read" } as const;
  const b = { canonicalId: "svc.beta", riskClass: "write" } as const;
  const c = { canonicalId: "svc.gamma", riskClass: "read" } as const;

  it("reports no changes when accepted and discovered match", () => {
    const diff = diffProviderTools("svc", "v1", "v1", [a, b], [a, b]);
    expect(diff.hasChanges).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("reports added and removed tools", () => {
    const diff = diffProviderTools("svc", "v1", "v2", [a, b], [a, c]);
    expect(diff.hasChanges).toBe(true);
    expect(diff.added.map((tool) => tool.canonicalId)).toEqual(["svc.gamma"]);
    expect(diff.removed.map((tool) => tool.canonicalId)).toEqual(["svc.beta"]);
    expect(diff.changed).toEqual([]);
  });

  it("reports a risk-class change on a retained tool", () => {
    const diff = diffProviderTools(
      "svc",
      "v1",
      "v2",
      [{ canonicalId: "svc.alpha", riskClass: "read" }],
      [{ canonicalId: "svc.alpha", riskClass: "admin" }]
    );
    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.riskClass).toBe("read");
    expect(diff.changed[0]?.after.riskClass).toBe("admin");
    expect(diff.changed[0]?.fields).toEqual(["riskClass"]);
  });
});
