/**
 * Extension Runtime Catalog — immutable registry-to-supervisor binding.
 * A captured policy snapshot owns one catalog reference, so discovery and dispatch cannot
 * mix a newly reloaded registry with supervisors from an older generation.
 */

import { createStdioAdapter } from "./stdio-adapter.js";
import { createStreamableHttpAdapter } from "./streamable-http-adapter.js";
import { type AdapterHealth, type ExtensionCallResult } from "./adapter.js";
import { createExtensionSupervisor, type SupervisorState } from "./supervisor.js";
import { type CompiledExtensionRegistry } from "./registry.js";

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
  provider(providerId: string): ExtensionProviderRuntime | undefined;
  isReady(providerId: string): boolean;
  /** Hold this generation until the returned release function is called. */
  acquire(): () => void;
  /** Prevent future ownership; stop only after all captured exchanges release. */
  retire(): void;
  stop(): Promise<void>;
}

/**
 * Start every declared provider before exposing this catalog. A failed provider is retained
 * as unavailable; it does not prevent unrelated providers or the gateway from starting.
 */
export async function createExtensionRuntimeCatalog(
  registry: CompiledExtensionRegistry
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
    const adapter =
      record.manifest.transport === "stdio"
        ? createStdioAdapter(record.manifest)
        : createStreamableHttpAdapter(record.manifest);
    const supervisor = createExtensionSupervisor({
      adapter,
      startupTimeoutMs: record.manifest.startupTimeoutMs,
      requestTimeoutMs: record.manifest.requestTimeoutMs,
      maxQueue: record.manifest.maxQueue,
      maxRestarts: record.manifest.maxRestarts
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
