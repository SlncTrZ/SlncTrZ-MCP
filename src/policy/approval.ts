/**
 * Approval Boundary — deterministic policy diff risk classification and hook contract.
 * Wing: policy | Topic: approval | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 4, ARCHITECTURE §4.7, ADR-018, and the Phase 4 handoff slice 4.
 *
 * A change is risk-increasing when it adds a workspace/client binding/profile/capability,
 * broadens a read/write/exec root or child PATH/fixed environment, or removes a deny/limit.
 * Access reductions and metadata-only rotations are not increases. The default hook is
 * unavailable; it never auto-approves based on caller, locality, ownership, or an env flag.
 *
 * The classifier compares normalized, frozen snapshots only. It uses set inclusion for
 * bindings and capabilities (never a raw length or a hand-picked field list, which would
 * let a substitution or a missed definition field slip through) and compares each exec
 * definition canonically across its full shape.
 */

import { isContainedPath } from "../kernel/fs-boundary.js";
import {
  type CompiledPolicyInput,
  type CompiledWorkspace,
  type CompiledBinding
} from "./policy-config.js";
import { type ActivePolicySnapshot } from "./policy-snapshot.js";
import { type ExecCommandDefinition } from "../kernel/exec.js";
import { type KernelCapability } from "./kernel-policy.js";

export type ApprovalDecision = "approved" | "rejected" | "unavailable";

export interface PolicyChangeSummary {
  readonly previousVersion: string;
  readonly candidateVersion: string;
  readonly riskIncrease: boolean;
  readonly workspaceCount: number;
  readonly bindingCount: number;
}

export type ApprovalHook = (change: PolicyChangeSummary) => Promise<ApprovalDecision>;

/** Default hook never approves; a risk-increasing reload is staged until a control plane exists. */
export const defaultApprovalHook: ApprovalHook = async () => "unavailable";

export interface RiskAssessment {
  readonly riskIncrease: boolean;
}

function keyWorkspaces(input: CompiledPolicyInput): ReadonlyMap<string, CompiledWorkspace> {
  return new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
}

function keyBindings(input: CompiledPolicyInput): ReadonlyMap<string, CompiledBinding> {
  return new Map(input.clientBindings.map((binding) => [binding.clientId, binding]));
}

/** Effective capabilities a workspace can grant across every configured profile. */
function effectiveCapabilities(workspace: CompiledWorkspace): ReadonlySet<string> {
  const set = new Set<string>();
  for (const profile of workspace.profiles) {
    let ceiling: readonly KernelCapability[];
    switch (profile) {
      case "read-only":
        ceiling = ["core.read", "core.search"];
        break;
      case "minimal":
        ceiling = ["core.read", "core.search", "core.write", "core.edit", "core.exec"];
        break;
      default:
        ceiling = workspace.customCapabilities ?? [];
        break;
    }
    for (const capability of ceiling) {
      if (workspace.kernelPolicy.capabilities.includes(capability)) set.add(capability);
    }
  }
  return set;
}

function setSubset(previous: ReadonlySet<string>, candidate: ReadonlySet<string>): boolean {
  for (const value of candidate) {
    if (!previous.has(value)) return false;
  }
  return true;
}

function orderedSubset(previous: readonly string[], candidate: readonly string[]): boolean {
  let previousIndex = 0;
  for (const value of candidate) {
    const found = previous.indexOf(value, previousIndex);
    if (found < 0) return false;
    previousIndex = found + 1;
  }
  return true;
}

function instructionContextRiskIncrease(
  previous: CompiledWorkspace,
  candidate: CompiledWorkspace
): boolean {
  const next = candidate.instructions;
  if (next === undefined) return false;
  const prior = previous.instructions;
  if (prior === undefined) return true;
  if (!orderedSubset(prior.userFiles, next.userFiles)) return true;
  if (!orderedSubset(prior.workspaceFiles, next.workspaceFiles)) return true;
  if (!orderedSubset(prior.directoryFileNames, next.directoryFileNames)) return true;
  return (
    next.maxFiles > prior.maxFiles ||
    next.maxFileBytes > prior.maxFileBytes ||
    next.maxContextBytes > prior.maxContextBytes
  );
}

function rootsBroadened(previous: CompiledWorkspace, candidate: CompiledWorkspace): boolean {
  const pairs: [string | undefined, string | undefined][] = [
    [previous.kernelPolicy.readRoot, candidate.kernelPolicy.readRoot],
    [previous.kernelPolicy.writeRoot, candidate.kernelPolicy.writeRoot],
    [previous.kernelPolicy.execRoot, candidate.kernelPolicy.execRoot]
  ];
  for (const [prevRoot, candRoot] of pairs) {
    if (candRoot === undefined) continue;
    if (prevRoot === undefined) return true;
    if (candRoot === prevRoot) continue;
    if (!isContainedPath(prevRoot, candRoot)) return true;
  }
  return false;
}

/** Canonical, order-independent form of one exec definition over its full shape. */
function canonicalCommand(command: ExecCommandDefinition): string {
  return JSON.stringify([
    command.commandId,
    command.binaryPath,
    command.fixedArgs,
    command.allowExtraArgs,
    command.allowedExtraArgPattern ?? null,
    command.maxExtraArgs,
    command.cwdMode,
    command.fixedEnv,
    command.allowStdin,
    command.commandClass,
    command.timeoutMs ?? null,
    command.maxOutputBytes ?? null
  ]);
}

/** Compare each workspace's exec command set and child PATH canonically (full definition). */
function execChanged(previous: CompiledWorkspace, candidate: CompiledWorkspace): boolean {
  if (previous.kernelPolicy.execPath !== candidate.kernelPolicy.execPath) return true;
  const prevCommands = previous.kernelPolicy.execCommands ?? [];
  const candCommands = candidate.kernelPolicy.execCommands ?? [];
  if (prevCommands.length !== candCommands.length) return true;
  const signature = (commands: readonly ExecCommandDefinition[]): string =>
    commands
      .map(canonicalCommand)
      .sort((left, right) => left.localeCompare(right))
      .join("|");
  return signature(prevCommands) !== signature(candCommands);
}

function workspaceRiskIncrease(previous: CompiledWorkspace, candidate: CompiledWorkspace): boolean {
  // Effective capability set is the source of truth for profile/capability risk: adding a
  // profile that grants new capabilities, or expanding customCapabilities, both widen the
  // effective set (an increase). A profile swap that only narrows access (e.g. minimal ->
  // read-only) shrinks the effective set and is not an increase, so it needs no approval.
  if (!setSubset(effectiveCapabilities(previous), effectiveCapabilities(candidate))) return true;
  if (rootsBroadened(previous, candidate)) return true;
  if (execChanged(previous, candidate)) return true;
  if (instructionContextRiskIncrease(previous, candidate)) return true;
  return false;
}

/** Effective extension access is expanded against the catalog so omitted tool/profile fields
 * are treated as all declared tools/profiles, never as an ambiguous wildcard. */
function effectiveExtensionAccess(
  input: CompiledPolicyInput,
  workspace: CompiledWorkspace
): ReadonlySet<string> {
  const access = new Set<string>();
  for (const grant of workspace.extensionGrants) {
    const profiles = grant.profiles.length === 0 ? workspace.profiles : grant.profiles;
    const providerTools = input.extensionRegistry.lookupProvider(grant.providerId);
    const tools =
      grant.toolIds.length === 0
        ? providerTools
        : providerTools.filter((tool) => grant.toolIds.includes(tool.canonicalId));
    for (const profile of profiles) {
      for (const tool of tools) access.add(`${profile}|${tool.canonicalId}|${tool.riskClass}`);
    }
  }
  return access;
}

function bindingRiskIncrease(previous: CompiledBinding, candidate: CompiledBinding): boolean {
  // Set inclusion, never a length comparison: same length with a substituted workspace is
  // still an escalation. Any candidate workspace not already granted is an increase.
  if (!setSubset(new Set(previous.workspaceIds), new Set(candidate.workspaceIds))) return true;
  return false;
}

/**
 * Classify a normalized policy change as risk-increasing. Comparison is over frozen
 * `CompiledPolicyInput` snapshots only; no paths or config text leave this module.
 */
export function classifyPolicyRisk(
  previous: CompiledPolicyInput,
  candidate: CompiledPolicyInput
): RiskAssessment {
  // Provider declaration changes affect transport, capability or risk ceilings. They are
  // conservatively approval-gated even if their tool IDs happen to be unchanged.
  if (previous.extensionRegistry.hash !== candidate.extensionRegistry.hash) {
    return { riskIncrease: true };
  }

  const prevWorkspaces = keyWorkspaces(previous);
  for (const workspace of candidate.workspaces) {
    const prior = prevWorkspaces.get(workspace.id);
    if (prior === undefined) return { riskIncrease: true };
    if (workspaceRiskIncrease(prior, workspace)) return { riskIncrease: true };
    if (
      !setSubset(
        effectiveExtensionAccess(previous, prior),
        effectiveExtensionAccess(candidate, workspace)
      )
    ) {
      return { riskIncrease: true };
    }
  }

  const prevBindings = keyBindings(previous);
  for (const binding of candidate.clientBindings) {
    const prior = prevBindings.get(binding.clientId);
    if (prior === undefined) return { riskIncrease: true };
    if (bindingRiskIncrease(prior, binding)) return { riskIncrease: true };
  }

  return { riskIncrease: false };
}

/** Build a deterministic, aggregated change summary carrying versions and counts only. */
export async function buildPolicyChangeSummary(
  previous: ActivePolicySnapshot,
  candidate: ActivePolicySnapshot
): Promise<PolicyChangeSummary> {
  const assessment = classifyPolicyRisk(previous.normalized, candidate.normalized);
  return {
    previousVersion: previous.version,
    candidateVersion: candidate.version,
    riskIncrease: assessment.riskIncrease,
    workspaceCount: candidate.normalized.workspaces.length,
    bindingCount: candidate.normalized.clientBindings.length
  };
}
