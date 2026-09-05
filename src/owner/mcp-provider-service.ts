/**
 * MCP Provider Management Service — typed CRUD, connection discovery and policy reload rollback.
 */

import type { ProviderCredential } from "../extension/adapter.js";
import { createStdioAdapter } from "../extension/stdio-adapter.js";
import { createStreamableHttpAdapter } from "../extension/streamable-http-adapter.js";
import {
  compileExtensionManifest,
  type ExtensionManifestV1,
  type ExtensionToolSchemaRecord
} from "../extension/manifest.js";
import type { PolicySnapshotStore, ReloadResult } from "../policy/policy-store.js";
import type { ManagedMcpProvider, McpProviderStore } from "./mcp-provider-store.js";
import {
  diffProviderTools,
  projectDiscoveredTools,
  type ProviderToolProjection,
  type ProviderToolDiff
} from "./mcp-presentation.js";

export interface McpProviderMutationResult {
  readonly provider?: ManagedMcpProvider;
  readonly removed?: boolean;
  readonly reload: ReloadResult;
}

export class McpProviderMutationError extends Error {
  readonly code = "mcp_provider_rollback_failed";
  readonly providerId: string;
  readonly rollbackComplete = false;

  constructor(providerId: string, cause: unknown) {
    super("Provider mutation failed and prior durable state could not be restored", { cause });
    this.name = "McpProviderMutationError";
    this.providerId = providerId;
  }
}

export interface McpProviderDiscovery {
  readonly providerId: string;
  readonly declaredTools: readonly string[];
  readonly discoveredTools: readonly string[];
  readonly matchesDeclaration: boolean;
  readonly discoveredDescriptions?: Readonly<Record<string, string>>;
}

/** Cached snapshot of a provider's last successful probe, so status derivation stays cheap. */
export interface McpDiscoveredSnapshot {
  readonly at: string;
  readonly tools: readonly ProviderToolProjection[];
  readonly diff: ProviderToolDiff;
}

export interface McpProviderService {
  list(): Promise<readonly ManagedMcpProvider[]>;
  addOrUpdate(input: {
    readonly manifest: ExtensionManifestV1;
    readonly name?: string;
    readonly enabled?: boolean;
  }): Promise<McpProviderMutationResult>;
  setEnabled(providerId: string, enabled: boolean): Promise<McpProviderMutationResult>;
  remove(providerId: string): Promise<McpProviderMutationResult>;
  discover(providerId: string): Promise<McpProviderDiscovery>;
  discoverCandidate(manifest: ExtensionManifestV1): Promise<McpProviderDiscovery>;
  acceptToolSet(
    providerId: string,
    tools: readonly ExtensionToolSchemaRecord[]
  ): Promise<McpProviderMutationResult>;
  /** Probe one provider and return the accepted-vs-discovered catalog diff (does not mutate). */
  toolDiff(providerId: string): Promise<ProviderToolDiff>;
  /** Probe one provider, then atomically accept the discovered catalog (persist + reload). */
  syncToDiscovered(providerId: string): Promise<McpProviderMutationResult>;
  /** Last cached probe snapshot for a provider (undefined until first probe). */
  getDiscovered(providerId: string): McpDiscoveredSnapshot | undefined;
}

export function createMcpProviderService(options: {
  readonly store: McpProviderStore;
  readonly policyStore: Pick<PolicySnapshotStore, "reload">;
  readonly resolveCredentials?: (refs: readonly string[]) => Promise<readonly ProviderCredential[]>;
}): McpProviderService {
  const activate = async (): Promise<ReloadResult> =>
    options.policyStore.reload({ ownerApproved: true });

  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.catch(() => undefined).then(operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const lastDiscovered = new Map<string, McpDiscoveredSnapshot>();

  const discoverManifest = async (
    rawManifest: ExtensionManifestV1
  ): Promise<McpProviderDiscovery> => {
    const manifest = await compileExtensionManifest(rawManifest);
    let credentials: readonly ProviderCredential[] = [];
    if (manifest.credentialRefs.length > 0) {
      if (options.resolveCredentials === undefined) {
        throw new Error("mcp_provider_credentials_unavailable");
      }
      credentials = await options.resolveCredentials(manifest.credentialRefs);
    }
    const adapter =
      manifest.transport === "stdio"
        ? createStdioAdapter(manifest, credentials)
        : createStreamableHttpAdapter(manifest, credentials);
    try {
      await adapter.start();
      const discoveredTools = await adapter.listTools();
      const discovered = discoveredTools
        .map((tool) => tool.canonicalId)
        .sort((left, right) => left.localeCompare(right));
      const declared = manifest.tools
        .map((tool) => tool.canonicalId)
        .sort((left, right) => left.localeCompare(right));
      const discoveredDescriptions: Record<string, string> = {};
      for (const tool of discoveredTools) {
        if (tool.description !== undefined && tool.description.length > 0) {
          discoveredDescriptions[tool.canonicalId] = tool.description;
        }
      }
      return Object.freeze({
        providerId: manifest.id,
        declaredTools: Object.freeze(declared),
        discoveredTools: Object.freeze(discovered),
        matchesDeclaration:
          declared.length === discovered.length &&
          declared.every((toolId, index) => toolId === discovered[index]),
        ...(Object.keys(discoveredDescriptions).length === 0
          ? {}
          : { discoveredDescriptions: Object.freeze(discoveredDescriptions) })
      });
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  };

  const discoverAndDiff = async (
    providerId: string
  ): Promise<{
    readonly provider: ManagedMcpProvider;
    readonly discovery: McpProviderDiscovery;
    readonly snapshot: McpDiscoveredSnapshot;
  }> => {
    const provider = await options.store.get(providerId);
    if (provider === undefined) throw new Error("mcp_provider_not_found");
    const discovery = await discoverManifest(provider.manifest);
    const accepted = provider.manifest.tools.map((tool) => ({
      canonicalId: tool.canonicalId,
      riskClass: tool.riskClass
    }));
    const projection = projectDiscoveredTools(
      providerId,
      accepted,
      discovery.discoveredTools,
      provider.manifest.transport,
      discovery.discoveredDescriptions
    );
    const at = new Date().toISOString();
    const diff = diffProviderTools(providerId, provider.updatedAt, at, accepted, projection);
    const snapshot: McpDiscoveredSnapshot = Object.freeze({ at, tools: projection, diff });
    lastDiscovered.set(providerId, snapshot);
    return { provider, discovery, snapshot };
  };

  // Canonical tool ids must be namespaced under their provider (`provider.tool`). The MCP
  // server reports bare names, so we prefix them here — this is the one place every persist
  // path (add, acceptTools, syncToDiscovered) flows through. Idempotent: an already-namespaced
  // id is left untouched. See docs/adr/adr-026-provider-tool-namespacing.md.
  const withNamespacedTools = (manifest: ExtensionManifestV1): ExtensionManifestV1 => {
    const tools = manifest.tools.map((tool) => ({
      canonicalId: tool.canonicalId.startsWith(`${manifest.id}.`)
        ? tool.canonicalId
        : `${manifest.id}.${tool.canonicalId}`,
      riskClass: tool.riskClass,
      ...(tool.description === undefined ? {} : { description: tool.description })
    }));
    return Object.freeze({ ...manifest, tools: Object.freeze(tools) });
  };

  const restoreProvider = async (
    prior: ManagedMcpProvider | undefined,
    providerId: string
  ): Promise<void> => {
    if (prior === undefined) {
      await options.store.remove(providerId);
      return;
    }
    await options.store.upsert({
      manifest: prior.manifest,
      ...(prior.name === undefined ? {} : { name: prior.name }),
      enabled: prior.enabled
    });
  };

  const addOrUpdateUnsafe = async (input: {
    readonly manifest: ExtensionManifestV1;
    readonly name?: string;
    readonly enabled?: boolean;
  }): Promise<McpProviderMutationResult> => {
    const prior = await options.store.get(input.manifest.id);
    const manifest = withNamespacedTools(input.manifest);
    const provider = await options.store.upsert({ ...input, manifest });
    let reload: ReloadResult;
    try {
      reload = await activate();
    } catch (error) {
      try {
        await restoreProvider(prior, provider.id);
      } catch (rollbackError) {
        throw new McpProviderMutationError(provider.id, rollbackError);
      }
      throw error;
    }
    if (reload.activated) return { provider, reload };
    try {
      await restoreProvider(prior, provider.id);
    } catch (rollbackError) {
      throw new McpProviderMutationError(provider.id, rollbackError);
    }
    return { provider, reload };
  };

  const addOrUpdate = (input: {
    readonly manifest: ExtensionManifestV1;
    readonly name?: string;
    readonly enabled?: boolean;
  }): Promise<McpProviderMutationResult> => serializeMutation(() => addOrUpdateUnsafe(input));

  const acceptTools = (
    providerId: string,
    tools: readonly ExtensionToolSchemaRecord[]
  ): Promise<McpProviderMutationResult> =>
    serializeMutation(async () => {
      const provider = await options.store.get(providerId);
      if (provider === undefined) throw new Error("mcp_provider_not_found");
      if (tools.length === 0) throw new Error("mcp_provider_tools_required");
      return addOrUpdateUnsafe({
        manifest: { ...provider.manifest, tools: [...tools] },
        ...(provider.name === undefined ? {} : { name: provider.name }),
        enabled: provider.enabled
      });
    });

  return Object.freeze({
    list() {
      return options.store.list();
    },
    addOrUpdate,
    setEnabled(providerId: string, enabled: boolean) {
      return serializeMutation(async () => {
        const prior = await options.store.get(providerId);
        if (prior === undefined) throw new Error("mcp_provider_not_found");
        const provider = await options.store.upsert({
          manifest: prior.manifest,
          ...(prior.name === undefined ? {} : { name: prior.name }),
          enabled
        });
        let reload: ReloadResult;
        try {
          reload = await activate();
        } catch (error) {
          try {
            await restoreProvider(prior, providerId);
          } catch (rollbackError) {
            throw new McpProviderMutationError(providerId, rollbackError);
          }
          throw error;
        }
        if (reload.activated) return { provider, reload };
        try {
          await restoreProvider(prior, providerId);
        } catch (rollbackError) {
          throw new McpProviderMutationError(providerId, rollbackError);
        }
        return { provider, reload };
      });
    },
    remove(providerId: string) {
      return serializeMutation(async () => {
        const prior = await options.store.get(providerId);
        if (prior === undefined) throw new Error("mcp_provider_not_found");
        await options.store.remove(providerId);
        let reload: ReloadResult;
        try {
          reload = await activate();
        } catch (error) {
          try {
            await restoreProvider(prior, providerId);
          } catch (rollbackError) {
            throw new McpProviderMutationError(providerId, rollbackError);
          }
          throw error;
        }
        if (reload.activated) return { removed: true, reload };
        try {
          await restoreProvider(prior, providerId);
        } catch (rollbackError) {
          throw new McpProviderMutationError(providerId, rollbackError);
        }
        return { removed: false, reload };
      });
    },
    async discover(providerId: string) {
      const { discovery } = await discoverAndDiff(providerId);
      return discovery;
    },
    discoverCandidate(manifest: ExtensionManifestV1) {
      return discoverManifest(manifest);
    },
    acceptToolSet: acceptTools,
    async toolDiff(providerId: string) {
      const { snapshot } = await discoverAndDiff(providerId);
      return snapshot.diff;
    },
    async syncToDiscovered(providerId: string) {
      const { snapshot } = await discoverAndDiff(providerId);
      if (snapshot.tools.length === 0) throw new Error("mcp_provider_tools_required");
      return acceptTools(providerId, snapshot.tools);
    },
    getDiscovered(providerId: string) {
      return lastDiscovered.get(providerId);
    }
  });
}
