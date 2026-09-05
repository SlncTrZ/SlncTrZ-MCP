/**
 * Extension Registry — canonical, frozen, collision-checked provider namespace.
 * Wing: extension | Topic: registry | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 1.
 *
 * Compiles a set of operator manifests into one immutable registry. Canonical tool IDs are
 * `providerId.toolName` and are part of a single global namespace; any duplicate provider,
 * duplicate tool, or cross-provider misuse is a fatal candidate-policy collision. The
 * registry sorts and hashes deterministically so an equivalent set yields one hash.
 */

import { createHash } from "node:crypto";
import {
  compileExtensionManifest,
  ExtensionManifestError,
  type CompiledExtensionManifest,
  type ExtensionManifestV1
} from "./manifest.js";
import { MAX_EXTENSIONS } from "./manifest.js";

export type ExtensionRegistryErrorCode = "registry_collision";

export class ExtensionRegistryError extends Error {
  readonly code: ExtensionRegistryErrorCode;

  constructor(code: ExtensionRegistryErrorCode, message: string) {
    super(message);
    this.name = "ExtensionRegistryError";
    this.code = code;
  }
}

export interface CompiledExtensionRecord {
  readonly id: string;
  readonly manifest: CompiledExtensionManifest;
}

export interface ExtensionToolRef {
  readonly canonicalId: string;
  readonly exposedName: string;
  readonly riskClass: "read" | "write" | "execute" | "network" | "admin";
  readonly providerId: string;
  readonly description?: string;
}

export interface CompiledExtensionRegistry {
  readonly extensions: readonly CompiledExtensionRecord[];
  readonly toolIndex: Readonly<Record<string, ExtensionToolRef>>;
  readonly hash: string;

  /** Look up one canonical tool id; undefined if unknown or cross-namespace. */
  lookup(canonicalId: string): ExtensionToolRef | undefined;
  /** Enumerate every tool in the catalog for one provider (catalog accessor, not auth). */
  lookupProvider(providerId: string): readonly ExtensionToolRef[];
}

function toRecord(manifest: CompiledExtensionManifest): CompiledExtensionRecord {
  return Object.freeze({ id: manifest.id, manifest });
}

function registryHash(extensions: readonly CompiledExtensionRecord[]): string {
  const canonical = JSON.stringify(
    extensions
      .map((entry) => ({
        id: entry.manifest.id,
        transport: entry.manifest.transport,
        version: entry.manifest.version,
        command: entry.manifest.command ?? null,
        args: entry.manifest.args,
        endpoint: entry.manifest.endpoint ?? null,
        tools: entry.manifest.tools
          .map((tool) => ({
            canonicalId: tool.canonicalId,
            riskClass: tool.riskClass,
            ...(tool.description === undefined ? {} : { description: tool.description })
          }))
          .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId)),
        envAllowlist: [...entry.manifest.envAllowlist].sort((left, right) =>
          left.localeCompare(right)
        ),
        credentialRefs: [...entry.manifest.credentialRefs].sort((left, right) =>
          left.localeCompare(right)
        ),
        startupTimeoutMs: entry.manifest.startupTimeoutMs,
        requestTimeoutMs: entry.manifest.requestTimeoutMs,
        maxOutputBytes: entry.manifest.maxOutputBytes,
        maxMessageBytes: entry.manifest.maxMessageBytes,
        maxQueue: entry.manifest.maxQueue,
        maxRestarts: entry.manifest.maxRestarts
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Compile a set of manifests into one frozen registry, failing on any collision. This is a
 * fatal candidate-policy error: the caller (e.g. a policy reload) must retain its prior
 * registry when this throws. No manifest text, secret or path leaves this module.
 */
export async function compileExtensionRegistry(
  manifests: readonly ExtensionManifestV1[]
): Promise<CompiledExtensionRegistry> {
  const records: CompiledExtensionRecord[] = [];
  const providerIds = new Set<string>();
  const toolIds = new Set<string>();

  if (manifests.length > MAX_EXTENSIONS) {
    throw new ExtensionRegistryError(
      "registry_collision",
      "Too many extensions exceeds the hard ceiling"
    );
  }

  for (const manifest of manifests) {
    let compiled: CompiledExtensionManifest;
    try {
      compiled = await compileExtensionManifest(manifest);
    } catch (error) {
      if (error instanceof ExtensionManifestError) throw error;
      throw new ExtensionRegistryError("registry_collision", "Manifest failed to compile");
    }
    if (compiled.tools.length === 0) {
      throw new ExtensionRegistryError(
        "registry_collision",
        "Persisted provider manifest must declare at least one tool"
      );
    }
    if (providerIds.has(compiled.id)) {
      throw new ExtensionRegistryError(
        "registry_collision",
        "Duplicate provider id is a fatal collision"
      );
    }
    providerIds.add(compiled.id);
    records.push(toRecord(compiled));
  }

  const toolIndex: Record<string, ExtensionToolRef> = {};
  for (const record of records) {
    for (const tool of record.manifest.tools) {
      if (!tool.canonicalId.startsWith(`${record.id}.`)) {
        throw new ExtensionRegistryError(
          "registry_collision",
          "Canonical tool id must be namespaced under its provider"
        );
      }
      if (toolIds.has(tool.canonicalId) || toolIndex[tool.canonicalId] !== undefined) {
        throw new ExtensionRegistryError(
          "registry_collision",
          "Canonical tool id collides across the registry"
        );
      }
      toolIds.add(tool.canonicalId);
      toolIndex[tool.canonicalId] = Object.freeze({
        canonicalId: tool.canonicalId,
        exposedName: tool.exposedName,
        riskClass: tool.riskClass,
        providerId: tool.providerId,
        ...(tool.description === undefined ? {} : { description: tool.description })
      });
    }
  }

  const frozenToolIndex = Object.freeze(toolIndex);
  const frozenRecords = Object.freeze(records);

  return Object.freeze({
    extensions: frozenRecords,
    toolIndex: frozenToolIndex,
    hash: registryHash(frozenRecords),
    lookup(canonicalId: string): ExtensionToolRef | undefined {
      return frozenToolIndex[canonicalId];
    },
    lookupProvider(providerId: string): readonly ExtensionToolRef[] {
      const tools: ExtensionToolRef[] = [];
      for (const record of frozenRecords) {
        if (record.id !== providerId) continue;
        for (const tool of record.manifest.tools) {
          const ref = frozenToolIndex[tool.canonicalId];
          if (ref !== undefined) tools.push(ref);
        }
      }
      return Object.freeze(tools.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId)));
    }
  });
}
