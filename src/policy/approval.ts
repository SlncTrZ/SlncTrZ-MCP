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
  return false;
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
  const prevWorkspaces = keyWorkspaces(previous);
  for (const workspace of candidate.workspaces) {
    const prior = prevWorkspaces.get(workspace.id);
    if (prior === undefined) return { riskIncrease: true };
    if (workspaceRiskIncrease(prior, workspace)) return { riskIncrease: true };
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
