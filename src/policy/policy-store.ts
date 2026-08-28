/**
 * Policy Snapshot Store — process-local atomic activation with failed-reload retention.
 * Wing: policy | Topic: policy-store | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 4, ARCHITECTURE §4.7, ADR-018, and the Phase 4 handoff slices 3 and 4.
 *
 * The store owns the single active policy snapshot reference. `capture` returns the stable
 * reference for one request; `reload` builds a candidate fully off to the side and only
 * replaces the active reference synchronously after the candidate compiles and freezes.
 * A failed candidate preserves the exact prior object and version. Reloads are serialized
 * with one mutex; a concurrent caller receives `reload_in_progress` without queuing.
 *
 * A risk-increasing candidate is staged behind an approval hook (default unavailable) and
 * returns `approval_required` while retaining the prior snapshot. Every reload attempt emits
 * exactly one secret-free audit event; an audit sink failure never undoes a completed
 * activation.
 */

import { PolicyConfigError, type PolicyConfigErrorCode } from "./policy-config.js";
import { type ActivePolicySnapshot } from "./policy-snapshot.js";
import {
  buildPolicyChangeSummary,
  defaultApprovalHook,
  type ApprovalHook,
  type PolicyChangeSummary
} from "./approval.js";
import {
  type PolicyAuditActorKind,
  type PolicyAuditEvent,
  type PolicyAuditSink
} from "../observability/policy-audit.js";

/** Load and compile a candidate policy snapshot. Production reads SLNCTRZ_POLICY_FILE. */
export type PolicySnapshotLoader = () => Promise<ActivePolicySnapshot>;

export type PolicyReloadResult = "activated" | "rejected" | "approval_required" | "failed";

export interface ReloadResult {
  readonly activated: boolean;
  readonly previousVersion: string;
  readonly activeVersion: string;
  readonly riskIncrease: boolean;
  readonly result: PolicyReloadResult;
  readonly failureCode?: PolicyConfigErrorCode;
}

export interface PolicySnapshotStore {
  /** Return the stable active snapshot reference; never reads policy from disk. */
  capture(): ActivePolicySnapshot;
  /** Atomically capture a snapshot and retain its extension runtime for one exchange. */
  captureLease(): { readonly snapshot: ActivePolicySnapshot; release(): void };
  /** Build a candidate off to the side and atomically activate it, or retain the prior one. */
  reload(options?: { readonly ownerApproved?: boolean }): Promise<ReloadResult>;
}

export interface PolicySnapshotStoreOptions {
  readonly approval?: ApprovalHook;
  readonly audit?: PolicyAuditSink;
}

function countsOf(snapshot: ActivePolicySnapshot): {
  workspaceCount: number;
  bindingCount: number;
} {
  return {
    workspaceCount: snapshot.normalized.workspaces.length,
    bindingCount: snapshot.normalized.clientBindings.length
  };
}

/** Emit an audit event; a sink failure must never undo an already-completed activation. */
function emitAudit(
  audit: PolicyAuditSink | undefined,
  event: Omit<PolicyAuditEvent, "timestamp">
): void {
  if (audit === undefined || audit === null) return;
  try {
    audit({ ...event, timestamp: new Date().toISOString() });
  } catch {
    // Sink failure is intentionally non-fatal to the activation decision.
  }
}

function retireSnapshotSafely(snapshot: ActivePolicySnapshot): void {
  try {
    snapshot.retire?.();
  } catch {
    // Runtime cleanup failure must not corrupt the active policy decision.
  }
}

function resultOf(
  outcome: Extract<PolicyReloadResult, "activated" | "rejected" | "approval_required">,
  previousVersion: string,
  active: ActivePolicySnapshot,
  candidate: ActivePolicySnapshot,
  riskIncrease: boolean
): ReloadResult {
  const activated = outcome === "activated";
  return {
    activated,
    previousVersion,
    activeVersion: activated ? candidate.version : active.version,
    riskIncrease,
    result: outcome
  };
}

/** Build a process-local snapshot store from an initial snapshot and a candidate loader. */
export function createPolicySnapshotStore(
  loader: PolicySnapshotLoader,
  initial: ActivePolicySnapshot,
  options: PolicySnapshotStoreOptions = {}
): PolicySnapshotStore {
  const approval = options.approval ?? defaultApprovalHook;
  const audit = options.audit;
  let active = initial;
  let reloadPromise: Promise<ReloadResult> | undefined;

  const actorKind: PolicyAuditActorKind = "internal_reload";

  return Object.freeze({
    capture(): ActivePolicySnapshot {
      return active;
    },
    captureLease(): { readonly snapshot: ActivePolicySnapshot; release(): void } {
      const snapshot = active;
      // Acquisition is synchronous with reading active, so a reload cannot retire this
      // generation between capture and lease establishment.
      const release = snapshot.acquireRuntime?.() ?? (() => undefined);
      return Object.freeze({ snapshot, release });
    },
    reload(reloadOptions: { readonly ownerApproved?: boolean } = {}): Promise<ReloadResult> {
      const reloadStartedAt = Date.now();
      const durationMs = (): number => Math.max(0, Date.now() - reloadStartedAt);
      if (reloadPromise !== undefined) {
        const counts = countsOf(active);
        emitAudit(audit, {
          eventType: "policy_reload",
          actorKind,
          previousVersion: active.version,
          candidateVersion: active.version,
          activeVersion: active.version,
          result: "failed",
          riskIncrease: false,
          ...counts,
          durationMs: durationMs()
        });
        return Promise.resolve({
          activated: false,
          previousVersion: active.version,
          activeVersion: active.version,
          riskIncrease: false,
          result: "failed",
          failureCode: "reload_in_progress"
        });
      }

      const previousVersion = active.version;
      const run = (async (): Promise<ReloadResult> => {
        let candidate: ActivePolicySnapshot;
        try {
          candidate = await loader();
        } catch (error) {
          const code = error instanceof PolicyConfigError ? error.code : undefined;
          const failureCode = code ?? "policy_invalid";
          const counts = countsOf(active);
          emitAudit(audit, {
            eventType: "policy_reload",
            actorKind,
            previousVersion,
            candidateVersion: active.version,
            activeVersion: active.version,
            result: "failed",
            riskIncrease: false,
            ...counts,
            durationMs: durationMs()
          });
          return {
            activated: false,
            previousVersion,
            activeVersion: active.version,
            riskIncrease: false,
            result: "failed",
            failureCode
          };
        }

        let summary: PolicyChangeSummary;
        try {
          summary = await buildPolicyChangeSummary(active, candidate);
        } catch (error) {
          retireSnapshotSafely(candidate);
          const failureCode = error instanceof PolicyConfigError ? error.code : "policy_invalid";
          const counts = countsOf(active);
          emitAudit(audit, {
            eventType: "policy_reload",
            actorKind,
            previousVersion,
            candidateVersion: candidate.version,
            activeVersion: active.version,
            result: "failed",
            riskIncrease: false,
            ...counts,
            durationMs: durationMs()
          });
          return {
            activated: false,
            previousVersion,
            activeVersion: active.version,
            riskIncrease: false,
            result: "failed",
            failureCode
          };
        }
        const { workspaceCount, bindingCount } = countsOf(candidate);

        if (!summary.riskIncrease) {
          // Access reduction or metadata-only rotation: activate without approval.
          const prior = active;
          active = candidate;
          retireSnapshotSafely(prior);
          emitAudit(audit, {
            eventType: "policy_reload",
            actorKind,
            previousVersion,
            candidateVersion: candidate.version,
            activeVersion: candidate.version,
            result: "activated",
            riskIncrease: false,
            workspaceCount,
            bindingCount,
            durationMs: durationMs()
          });
          return {
            activated: true,
            previousVersion,
            activeVersion: candidate.version,
            riskIncrease: false,
            result: "activated"
          };
        }

        // Risk-increasing: defer to the approval hook. Never auto-approve.
        let decision: "approved" | "rejected" | "unavailable";
        try {
          decision = reloadOptions.ownerApproved === true ? "approved" : await approval(summary);
        } catch {
          decision = "unavailable";
        }

        if (decision === "approved") {
          const prior = active;
          active = candidate;
          retireSnapshotSafely(prior);
          emitAudit(audit, {
            eventType: "policy_reload",
            actorKind,
            previousVersion,
            candidateVersion: candidate.version,
            activeVersion: candidate.version,
            result: "activated",
            riskIncrease: true,
            workspaceCount,
            bindingCount,
            durationMs: durationMs()
          });
          return resultOf("activated", previousVersion, active, candidate, true);
        }

        const outcome = decision === "rejected" ? "rejected" : "approval_required";
        retireSnapshotSafely(candidate);
        emitAudit(audit, {
          eventType: "policy_reload",
          actorKind,
          previousVersion,
          candidateVersion: candidate.version,
          activeVersion: active.version,
          result: outcome,
          riskIncrease: true,
          workspaceCount,
          bindingCount,
          durationMs: durationMs()
        });
        return resultOf(outcome, previousVersion, active, candidate, true);
      })();

      reloadPromise = run.finally(() => {
        reloadPromise = undefined;
      });
      return reloadPromise;
    }
  });
}
