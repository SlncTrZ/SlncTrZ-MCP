/**
 * Immutable Active Policy Snapshot — per-workspace/profile resolution for one request.
 * Wing: policy | Topic: policy-snapshot | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 4, ARCHITECTURE §4.7, ADR-018, and the Phase 4 handoff slice 2.
 *
 * The active snapshot is a frozen, versioned whole-document view. Its `resolve` method
 * selects one workspace (bound to the principal) and one profile, returning a
 * profile-filtered immutable KernelPolicySnapshot. No snapshot reads policy from disk.
 */

import { createHash } from "node:crypto";
import {
  type CompiledPolicyInput,
  type CompiledWorkspace,
  type ProfileName
} from "./policy-config.js";
import { PolicyConfigError } from "./policy-config.js";
import {
  type AuthenticatedPrincipal,
  type KernelCapability,
  type KernelPolicySnapshot
} from "./kernel-policy.js";

export interface ActivePolicySnapshot {
  readonly version: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly hasWorkspaces: boolean;
  /** Normalized, frozen compile input retained for deterministic policy diffing. */
  readonly normalized: CompiledPolicyInput;
  resolve(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    profile?: ProfileName
  ): KernelPolicySnapshot;
}

function canonicalHash(compiled: CompiledPolicyInput): string {
  const workspaces = [...compiled.workspaces]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((w) =>
      [
        w.id,
        w.kernelPolicy.version,
        [...w.profiles].sort().join(","),
        [...w.customCapabilities].sort().join(",")
      ].join("|")
    );
  const bindings = [...compiled.clientBindings]
    .sort((a, b) => a.clientId.localeCompare(b.clientId))
    .map((b) =>
      [b.clientId, [...b.workspaceIds].slice().sort().join(","), b.defaultWorkspaceId ?? ""].join(
        "|"
      )
    );
  const canonical = JSON.stringify({ schemaVersion: 1, workspaces, bindings });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function profileCapabilities(
  profile: ProfileName,
  workspace: CompiledWorkspace
): readonly KernelCapability[] {
  if (profile === "read-only") return ["core.read", "core.search"];
  if (profile === "minimal") {
    return ["core.read", "core.search", "core.write", "core.edit", "core.exec"];
  }
  return workspace.customCapabilities;
}

function buildResolvedSnapshot(
  workspace: CompiledWorkspace,
  activeVersion: string,
  enabled: readonly KernelCapability[]
): KernelPolicySnapshot {
  const readRoot =
    enabled.includes("core.read") || enabled.includes("core.search")
      ? workspace.kernelPolicy.readRoot
      : undefined;
  const writeRoot =
    enabled.includes("core.write") || enabled.includes("core.edit")
      ? workspace.kernelPolicy.writeRoot
      : undefined;
  const execEnabled = enabled.includes("core.exec");

  return Object.freeze({
    version: activeVersion,
    workspaceId: workspace.id,
    capabilities: Object.freeze([...enabled]),
    ...(readRoot === undefined ? {} : { readRoot }),
    ...(writeRoot === undefined ? {} : { writeRoot }),
    ...(execEnabled && workspace.kernelPolicy.execRoot !== undefined
      ? {
          execRoot: workspace.kernelPolicy.execRoot,
          ...(workspace.kernelPolicy.execPath === undefined
            ? {}
            : { execPath: workspace.kernelPolicy.execPath }),
          ...(workspace.kernelPolicy.execCommands === undefined
            ? {}
            : { execCommands: workspace.kernelPolicy.execCommands })
        }
      : {})
  });
}

/** Build the frozen active snapshot from a compiled policy input. */
export function buildActivePolicySnapshot(compiled: CompiledPolicyInput): ActivePolicySnapshot {
  const version = canonicalHash(compiled);
  return Object.freeze({
    version,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    hasWorkspaces: compiled.workspaces.length > 0,
    normalized: compiled,
    resolve(principal: AuthenticatedPrincipal, workspaceId: string, profile?: ProfileName) {
      const binding = compiled.clientBindings.find((b) => b.clientId === principal.clientId);
      if (binding === undefined) {
        throw new PolicyConfigError("workspace_denied", "Client is not bound to any workspace");
      }
      if (!binding.workspaceIds.includes(workspaceId)) {
        throw new PolicyConfigError(
          "workspace_denied",
          "Workspace is not authorized for this client"
        );
      }
      const workspace = compiled.workspaces.find((w) => w.id === workspaceId);
      if (workspace === undefined) {
        throw new PolicyConfigError("workspace_unknown", "Unknown workspace");
      }
      const selectedProfile =
        profile ?? (workspace.profiles.length === 1 ? workspace.profiles[0] : undefined);
      if (selectedProfile === undefined || !workspace.profiles.includes(selectedProfile)) {
        throw new PolicyConfigError("profile_unknown", "Unknown profile");
      }
      const enabled = profileCapabilities(selectedProfile, workspace).filter((cap) =>
        workspace.kernelPolicy.capabilities.includes(cap)
      );
      return buildResolvedSnapshot(workspace, version, enabled);
    }
  });
}
