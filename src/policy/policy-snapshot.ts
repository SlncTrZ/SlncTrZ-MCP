/** Immutable active product snapshot — authenticated clients always use one default policy. */

import { createHash } from "node:crypto";
import type { CompiledPolicyInput } from "./policy-config.js";
import { PolicyConfigError } from "./policy-config.js";
import type {
  AuthenticatedPrincipal,
  KernelPolicySnapshot,
  ResolvedExtensionTool
} from "./kernel-policy.js";
import type { ExtensionRuntimeCatalog } from "../extension/runtime.js";

export interface ActivePolicySnapshot {
  readonly version: string;
  readonly schemaVersion: 2;
  readonly createdAt: string;
  readonly hasWorkspaces: boolean;
  readonly normalized: CompiledPolicyInput;
  readonly toolCatalogFingerprint: string;
  extensionStatus?(): ReturnType<NonNullable<ExtensionRuntimeCatalog["status"]>>;
  retire?(): void;
  acquireRuntime?(): () => void;
  resolve(principal: AuthenticatedPrincipal): KernelPolicySnapshot;
}

function canonicalHash(compiled: CompiledPolicyInput): string {
  const canonical = JSON.stringify({
    schemaVersion: compiled.schemaVersion,
    kernelPolicy: compiled.kernelPolicy.version,
    extensionRegistry: compiled.extensionRegistry.hash
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function toolCatalogFingerprint(
  compiled: CompiledPolicyInput,
  extensionRuntime?: ExtensionRuntimeCatalog
): string {
  const coreTools = ["core.ping", ...compiled.kernelPolicy.capabilities].sort();
  const extensionTools = Object.values(compiled.extensionRegistry.toolIndex)
    .filter((tool) => extensionRuntime?.isReady(tool.providerId) ?? false)
    .map((tool) => {
      const serverDescription = compiled.extensionRegistry.extensions.find(
        (entry) => entry.id === tool.providerId
      )?.manifest.description;
      return {
        canonicalId: tool.canonicalId,
        providerId: tool.providerId,
        riskClass: tool.riskClass,
        description: tool.description ?? null,
        serverDescription: serverDescription ?? null
      };
    })
    .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
  return createHash("sha256")
    .update(JSON.stringify({ coreTools, extensionTools }))
    .digest("hex")
    .slice(0, 16);
}

function allExtensionTools(compiled: CompiledPolicyInput): readonly ResolvedExtensionTool[] {
  return Object.values(compiled.extensionRegistry.toolIndex)
    .map((tool) =>
      Object.freeze({
        canonicalId: tool.canonicalId,
        providerId: tool.providerId,
        riskClass: tool.riskClass,
        ...(tool.description === undefined ? {} : { description: tool.description })
      })
    )
    .sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
}

export function buildActivePolicySnapshot(
  compiled: CompiledPolicyInput,
  extensionRuntime?: ExtensionRuntimeCatalog
): ActivePolicySnapshot {
  const version = canonicalHash(compiled);
  const advertisedToolCatalogFingerprint = toolCatalogFingerprint(compiled, extensionRuntime);
  return Object.freeze({
    version,
    toolCatalogFingerprint: advertisedToolCatalogFingerprint,
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    hasWorkspaces: compiled.kernelPolicy.readRoots !== undefined,
    normalized: compiled,
    ...(extensionRuntime === undefined
      ? {}
      : {
          extensionStatus: () => extensionRuntime.status?.() ?? [],
          retire: () => extensionRuntime.retire(),
          acquireRuntime: () => extensionRuntime.acquire()
        }),
    resolve(principal: AuthenticatedPrincipal): KernelPolicySnapshot {
      if (!principal.scopes.includes("mcp:tools")) {
        throw new PolicyConfigError("workspace_denied", "Client lacks mcp:tools scope");
      }
      return Object.freeze({
        ...compiled.kernelPolicy,
        version,
        extensions: allExtensionTools(compiled),
        toolCatalogFingerprint: advertisedToolCatalogFingerprint,
        ...(extensionRuntime === undefined ? {} : { extensionRuntime })
      });
    }
  });
}
