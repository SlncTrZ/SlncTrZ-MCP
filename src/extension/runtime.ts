/**
 * Extension Runtime Catalog — immutable registry-to-supervisor binding.
 * A captured policy snapshot owns one catalog reference, so discovery and dispatch cannot
 * mix a newly reloaded registry with supervisors from an older generation.
 */

import { createStdioAdapter } from "./stdio-adapter.js";
import { createStreamableHttpAdapter } from "./streamable-http-adapter.js";
import { toolNameOf } from "../kernel/tool-identity.js";
import {
  AdapterError,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo,
  type ProviderCredential
} from "./adapter.js";
import { createExtensionSupervisor, type SupervisorState } from "./supervisor.js";
import { type CompiledExtensionRegistry } from "./registry.js";
import type { MetricsRegistry } from "../observability/metrics.js";

export interface ExtensionProviderRuntime {
  readonly state: SupervisorState;
  start(): Promise<void>;
  health(): AdapterHealth;
  invoke(
    toolId: string,
    args: unknown,
    options?: { readonly signal?: AbortSignal }
  ): Promise<ExtensionCallResult>;
  stop(): Promise<void>;
}

export interface ExtensionRuntimeCatalog {
  readonly registry: CompiledExtensionRegistry;
  status?(): readonly Readonly<{
    providerId: string;
    state: SupervisorState;
    health: AdapterHealth;
  }>[];
  provider(providerId: string): ExtensionProviderRuntime | undefined;
  isReady(providerId: string): boolean;
  /** Hold this generation until the returned release function is called. */
  acquire(): () => void;
  /** Prevent future ownership; stop only after all captured exchanges release. */
  retire(): void;
  stop(): Promise<void>;
}

function attestDeclaredTools(
  adapter: ExtensionAdapter,
  providerId: string,
  declaredIds: readonly string[]
): ExtensionAdapter {
  let attested = false;
  const expected = declaredIds
    .map((canonicalId) => toolNameOf(canonicalId))
    .sort((left, right) => left.localeCompare(right));
  const expectedSet = new Set(expected);

  return {
    async start(): Promise<void> {
      attested = false;
      await adapter.start();
      try {
        const discovered = await adapter.listTools();
        const actual = discovered
          .map((tool) => {
            if (
              tool.canonicalId !== tool.exposedName ||
              tool.exposedName.startsWith(`${providerId}.`)
            ) {
              return "__invalid_exposed_name__";
            }
            return tool.exposedName;
          })
          .sort((left, right) => left.localeCompare(right));
        if (actual.includes("__invalid_exposed_name__")) {
          throw new AdapterError("provider_protocol_error", "provider tool declaration mismatch");
        }
        const discoveredNames = new Set(actual);
        if (expected.some((toolId) => !discoveredNames.has(toolId))) {
          throw new AdapterError("provider_protocol_error", "provider tool declaration mismatch");
        }
        attested = true;
      } catch (error) {
        await adapter.stop();
        if (error instanceof AdapterError) throw error;
        throw new AdapterError("provider_protocol_error", "provider tool discovery failed");
      }
    },
    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      if (!attested) {
        throw new AdapterError("provider_unavailable", "provider_unavailable");
      }
      const discovered = await adapter.listTools();
      return discovered.filter(
        (tool) =>
          tool.canonicalId === tool.exposedName &&
          !tool.exposedName.startsWith(`${providerId}.`) &&
          expectedSet.has(tool.exposedName)
      );
    },
    callTool(toolId, args, options): Promise<ExtensionCallResult> {
      if (!attested) {
        return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      }
      return adapter.callTool(toolId, args, options);
    },
    async stop(): Promise<void> {
      attested = false;
      await adapter.stop();
    },
    health(): AdapterHealth {
      return attested ? adapter.health() : "unavailable";
    }
  };
}

/**
 * Start every declared provider and attest its discovered canonical tool set before exposure.
 * A failed or drifted provider is retained as unavailable; unrelated providers still start.
 */
export async function createExtensionRuntimeCatalog(
  registry: CompiledExtensionRegistry,
  metrics?: MetricsRegistry,
  credentialResolver?: (refs: readonly string[]) => Promise<readonly ProviderCredential[]>,
  disabledProviderIds: ReadonlySet<string> = new Set()
): Promise<ExtensionRuntimeCatalog> {
  const providers = new Map<string, ExtensionProviderRuntime>();
  let leases = 0;
  let retired = false;
  let stopped = false;

  const stopOnce = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all([...providers.values()].map((provider) => provider.stop()));
  };
  const release = (): void => {
    leases = Math.max(0, leases - 1);
    if (retired && leases === 0) void stopOnce();
  };

  for (const record of registry.extensions) {
    const administrativelyDisabled = disabledProviderIds.has(record.id);
    let credentials: readonly ProviderCredential[] = [];
    let credentialError = false;
    if (record.manifest.credentialRefs.length > 0) {
      try {
        if (credentialResolver === undefined) throw new Error("credential resolver unavailable");
        credentials = await credentialResolver(record.manifest.credentialRefs);
      } catch {
        credentialError = true;
      }
    }
    const transportAdapter: ExtensionAdapter =
      administrativelyDisabled || credentialError
        ? {
            async start() {
              throw new AdapterError("provider_unavailable", "provider credentials unavailable");
            },
            async listTools() {
              throw new AdapterError("provider_unavailable", "provider_unavailable");
            },
            async callTool() {
              throw new AdapterError("provider_unavailable", "provider_unavailable");
            },
            async stop(): Promise<void> {
              return;
            },
            health() {
              return "unavailable" as const;
            }
          }
        : record.manifest.transport === "stdio"
          ? createStdioAdapter(record.manifest, credentials)
          : createStreamableHttpAdapter(record.manifest, credentials);
    const adapter = attestDeclaredTools(
      transportAdapter,
      record.id,
      record.manifest.tools.map((tool) => tool.canonicalId)
    );
    const supervisor = createExtensionSupervisor({
      adapter,
      startupTimeoutMs: record.manifest.startupTimeoutMs,
      requestTimeoutMs: record.manifest.requestTimeoutMs,
      maxQueue: record.manifest.maxQueue,
      maxRestarts: record.manifest.maxRestarts,
      ...(metrics === undefined ? {} : { metrics })
    });
    providers.set(record.id, supervisor);
  }

  for (const provider of providers.values()) {
    try {
      await provider.start();
    } catch {
      // The supervisor remains unavailable and therefore invisible to discovery.
    }
  }

  return Object.freeze({
    registry,
    status() {
      return Object.freeze(
        [...providers.entries()].map(([providerId, provider]) =>
          Object.freeze({ providerId, state: provider.state, health: provider.health() })
        )
      );
    },
    provider(providerId: string): ExtensionProviderRuntime | undefined {
      return providers.get(providerId);
    },
    isReady(providerId: string): boolean {
      const provider = providers.get(providerId);
      return !stopped && provider?.state === "ready" && provider.health() === "ready";
    },
    acquire(): () => void {
      leases += 1;
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        release();
      };
    },
    retire(): void {
      retired = true;
      if (leases === 0) void stopOnce();
    },
    async stop(): Promise<void> {
      retired = true;
      await stopOnce();
    }
  });
}
