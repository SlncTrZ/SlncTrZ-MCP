/**
 * MCP Provider Presentation — normalized product status and detail projection.
 * Wing: owner | Topic: mcp-presentation | Updated: 2026-08-30
 *
 * Pure, backend-side derivation so the Owner Console never re-derives product state
 * from raw supervisor/adapter strings. Policy Engine remains the sole authorization
 * authority; this module only describes provider capability/health for the UI.
 */

import type { ManagedMcpProvider } from "./mcp-provider-store.js";
import type { McpCredentialMetadata } from "./mcp-credential-store.js";
import type { SupervisorState } from "../extension/supervisor.js";
import type { AdapterHealth } from "../extension/adapter.js";
import type { RiskClass } from "../kernel/tool-identity.js";

export interface ProviderRuntime {
  readonly state: SupervisorState;
  readonly health: AdapterHealth;
}

export type ProviderProductStatus =
  | "ready"
  | "connecting"
  | "restarting"
  | "auth_required"
  | "needs_sync"
  | "unavailable"
  | "disabled";

export interface ProviderStatusInput {
  readonly enabled: boolean;
  readonly runtime?: ProviderRuntime | undefined;
  /** A credential ref the manifest requires is unresolvable (or a known auth failure). */
  readonly credentialMissing: boolean;
  /** Accepted vs discovered tools differ materially. */
  readonly toolDrift: boolean;
}

/** Applied worst-first: Disabled > Auth required > Needs sync > Restarting > Connecting > Unavailable > Ready. */
export function deriveProviderStatus(input: ProviderStatusInput): ProviderProductStatus {
  if (!input.enabled) return "disabled";
  if (input.credentialMissing) return "auth_required";
  if (input.toolDrift) return "needs_sync";
  const runtime = input.runtime;
  if (runtime === undefined) return "unavailable";
  if (
    runtime.state === "restarting" ||
    runtime.state === "degraded" ||
    runtime.health === "degraded"
  ) {
    return "restarting";
  }
  if (runtime.state === "starting" || runtime.state === "declared") return "connecting";
  if (
    runtime.state === "quarantined" ||
    runtime.state === "failed" ||
    runtime.state === "stopped" ||
    runtime.health === "unavailable"
  ) {
    return "unavailable";
  }
  return "ready";
}

export type ProviderFailureClass =
  "auth_required" | "connection_failed" | "protocol_error" | "tool_drift" | "provider_unavailable";

/** Conservative failure classification: only explicit signals map to auth_required, never arbitrary text. */
export function classifyProviderFailure(
  credentialMissing: boolean,
  runtimeUnavailable: boolean
): ProviderFailureClass {
  if (credentialMissing) return "auth_required";
  if (runtimeUnavailable) return "provider_unavailable";
  return "connection_failed";
}

export interface ProviderToolProjection {
  readonly canonicalId: string;
  readonly riskClass: RiskClass;
  readonly description?: string;
}

export interface ProviderToolDiff {
  readonly providerId: string;
  readonly acceptedVersion: string;
  readonly discoveredVersion: string;
  readonly added: readonly ProviderToolProjection[];
  readonly removed: readonly ProviderToolProjection[];
  readonly changed: readonly {
    before: ProviderToolProjection;
    after: ProviderToolProjection;
    fields: readonly string[];
  }[];
  readonly hasChanges: boolean;
}

/** Deterministic accepted-vs-discovered tool diff, keyed by canonical id. */
export function diffProviderTools(
  providerId: string,
  acceptedVersion: string,
  discoveredVersion: string,
  accepted: readonly ProviderToolProjection[],
  discovered: readonly ProviderToolProjection[]
): ProviderToolDiff {
  const acceptedById = new Map(accepted.map((tool) => [tool.canonicalId, tool]));
  const discoveredById = new Map(discovered.map((tool) => [tool.canonicalId, tool]));
  const added: ProviderToolProjection[] = [];
  const removed: ProviderToolProjection[] = [];
  const changed: {
    before: ProviderToolProjection;
    after: ProviderToolProjection;
    fields: string[];
  }[] = [];

  for (const tool of discovered) {
    const prior = acceptedById.get(tool.canonicalId);
    if (prior === undefined) {
      added.push(tool);
    } else if (prior.riskClass !== tool.riskClass) {
      changed.push({ before: prior, after: tool, fields: ["riskClass"] });
    }
  }
  for (const tool of accepted) {
    if (!discoveredById.has(tool.canonicalId)) removed.push(tool);
  }

  const sortById = (list: readonly ProviderToolProjection[]): readonly ProviderToolProjection[] =>
    Object.freeze(
      [...list].sort((left, right) => left.canonicalId.localeCompare(right.canonicalId))
    );
  return {
    providerId,
    acceptedVersion,
    discoveredVersion,
    added: sortById(added),
    removed: sortById(removed),
    changed: Object.freeze(
      [...changed].sort((left, right) =>
        left.before.canonicalId.localeCompare(right.before.canonicalId)
      )
    ),
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0
  };
}

/** Conservative risk class for a newly discovered tool whose risk profile is not yet registered. */
export function discoverRiskClass(transport: "stdio" | "streamable-http"): RiskClass {
  return transport === "stdio" ? "execute" : "network";
}

/**
 * Project a provider's freshly reported (discovered) canonical tool ids into the normalized
 * product shape, reusing the registered risk class where one exists and otherwise assigning a
 * conservative transport-appropriate class. Drift detection never invents elevated risk.
 */
export function projectDiscoveredTools(
  providerId: string,
  accepted: readonly ProviderToolProjection[],
  discoveredIds: readonly string[],
  transport: "stdio" | "streamable-http",
  discoveredDescriptions?: Readonly<Record<string, string>>
): readonly ProviderToolProjection[] {
  const acceptedRisk = new Map(accepted.map((tool) => [tool.canonicalId, tool.riskClass]));
  return Object.freeze(
    discoveredIds.map((bareId) => {
      // Advertised tools are reported as bare names; project them under the provider id so
      // the accepted-vs-discovered diff (and the needs_sync derivation) compares like-for-like.
      const canonicalId = bareId.startsWith(`${providerId}.`) ? bareId : `${providerId}.${bareId}`;
      return {
        canonicalId,
        riskClass: acceptedRisk.get(canonicalId) ?? discoverRiskClass(transport),
        ...(discoveredDescriptions?.[bareId] === undefined
          ? {}
          : { description: discoveredDescriptions[bareId] })
      };
    })
  );
}

export interface OwnerMcpProviderDetail {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: ProviderProductStatus;
  readonly connection: {
    readonly kind: "remote" | "local";
    readonly endpoint?: string;
    readonly command?: string;
    readonly args?: readonly string[];
  };
  readonly auth: {
    readonly kind: "none" | "bearer" | "header" | "env";
    readonly configured: boolean;
    readonly name?: string;
    /** Opaque credential reference identifier (never a secret value). */
    readonly ref?: string;
  };
  readonly tools: {
    readonly accepted: readonly ProviderToolProjection[];
    readonly acceptedCount: number;
    readonly discoveredCount?: number;
    readonly needsSync: boolean;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly granted: boolean;
    readonly mode: "all" | "subset";
    readonly toolIds?: readonly string[];
  };
  readonly health: {
    readonly status: ProviderProductStatus;
    readonly lastProbeAt?: string;
    readonly needsSync: boolean;
  };
}

export interface ProjectProviderDetailInput {
  readonly provider: ManagedMcpProvider;
  readonly runtime?: ProviderRuntime | undefined;
  readonly credentials: readonly McpCredentialMetadata[];
  readonly workspaceId: string;
  readonly grantToolIds?: readonly string[];
  readonly workspaceGranted: boolean;
  readonly toolDrift: boolean;
  readonly discoveredCount?: number;
  /** As-of time of the last successful probe, when one has run. */
  readonly discoveredAt?: string;
}

/** Map a credential ref (or its absence) to the product auth mode, never exposing any secret value. */
function authMode(
  refs: readonly string[] | undefined,
  credentials: readonly McpCredentialMetadata[]
): {
  kind: "none" | "bearer" | "header" | "env";
  configured: boolean;
  name?: string;
  ref?: string;
} {
  if (refs === undefined || refs.length === 0) return { kind: "none", configured: false };
  const first = credentials.find((candidate) => refs.includes(candidate.ref));
  if (first === undefined) {
    return {
      kind: "none",
      configured: false,
      ...(refs[0] === undefined ? {} : { ref: refs[0] })
    };
  }
  const kind = first.kind === "http-header" ? "header" : first.kind === "env" ? "env" : "bearer";
  return {
    kind,
    configured: true,
    ...(first.name === undefined ? {} : { name: first.name }),
    ...(refs[0] === undefined ? {} : { ref: refs[0] })
  };
}

export function projectProviderDetail(input: ProjectProviderDetailInput): OwnerMcpProviderDetail {
  const manifest = input.provider.manifest;
  const credentialMissing =
    (manifest.credentialRefs?.length ?? 0) > 0 &&
    !(manifest.credentialRefs ?? []).some((ref) =>
      input.credentials.some((candidate) => candidate.ref === ref)
    );
  const status = deriveProviderStatus({
    enabled: input.provider.enabled,
    runtime: input.runtime,
    credentialMissing,
    toolDrift: input.toolDrift
  });
  const auth = authMode(manifest.credentialRefs, input.credentials);
  const accepted = manifest.tools.map((tool) => ({
    canonicalId: tool.canonicalId,
    riskClass: tool.riskClass
  }));
  const isLocal = manifest.transport === "stdio";
  const mode =
    input.grantToolIds === undefined || input.grantToolIds.length === 0
      ? ("all" as const)
      : ("subset" as const);

  return {
    id: input.provider.id,
    name: input.provider.name ?? input.provider.id,
    enabled: input.provider.enabled,
    status,
    connection: {
      kind: isLocal ? "local" : "remote",
      ...(isLocal
        ? {
            ...(manifest.command === undefined ? {} : { command: manifest.command }),
            ...(manifest.args === undefined ? {} : { args: manifest.args })
          }
        : { ...(manifest.endpoint === undefined ? {} : { endpoint: manifest.endpoint }) })
    },
    auth,
    tools: {
      accepted,
      acceptedCount: accepted.length,
      ...(input.discoveredCount === undefined ? {} : { discoveredCount: input.discoveredCount }),
      needsSync: input.toolDrift
    },
    workspace: {
      workspaceId: input.workspaceId,
      granted: input.workspaceGranted,
      mode,
      ...(mode === "subset" ? { toolIds: input.grantToolIds } : {})
    },
    health: {
      status,
      ...(input.discoveredAt === undefined ? {} : { lastProbeAt: input.discoveredAt }),
      needsSync: input.toolDrift
    }
  };
}
