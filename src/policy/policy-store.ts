/**
 * Policy Snapshot Store — atomic validated generation swap with failed-reload retention.
 */

import { PolicyConfigError, type PolicyConfigErrorCode } from "./policy-config.js";
import type { ActivePolicySnapshot } from "./policy-snapshot.js";
import type { PolicyAuditEvent, PolicyAuditSink } from "../observability/policy-audit.js";

export type PolicySnapshotLoader = () => Promise<ActivePolicySnapshot>;
export type PolicyReloadResult = "activated" | "failed";

export interface ReloadResult {
  readonly activated: boolean;
  readonly previousVersion: string;
  readonly activeVersion: string;
  readonly riskIncrease: false;
  readonly result: PolicyReloadResult;
  readonly failureCode?: PolicyConfigErrorCode;
}

export interface PolicySnapshotStore {
  capture(): ActivePolicySnapshot;
  captureLease(): { readonly snapshot: ActivePolicySnapshot; release(): void };
  reload(_options?: { readonly ownerApproved?: boolean }): Promise<ReloadResult>;
}

export interface PolicySnapshotStoreOptions {
  readonly audit?: PolicyAuditSink;
  readonly onActivated?: (previous: ActivePolicySnapshot, active: ActivePolicySnapshot) => void;
}

function emitAudit(
  audit: PolicyAuditSink | undefined,
  event: Omit<PolicyAuditEvent, "timestamp">
): void {
  if (audit === undefined) return;
  try {
    audit({ ...event, timestamp: new Date().toISOString() });
  } catch {
    // Observability cannot alter activation semantics.
  }
}

function retireSnapshotSafely(snapshot: ActivePolicySnapshot): void {
  try {
    snapshot.retire?.();
  } catch {
    // Runtime cleanup failure cannot corrupt the active generation.
  }
}

export function createPolicySnapshotStore(
  loader: PolicySnapshotLoader,
  initial: ActivePolicySnapshot,
  options: PolicySnapshotStoreOptions = {}
): PolicySnapshotStore {
  let active = initial;
  let reloadPromise: Promise<ReloadResult> | undefined;

  return Object.freeze({
    capture(): ActivePolicySnapshot {
      return active;
    },
    captureLease() {
      const snapshot = active;
      const release = snapshot.acquireRuntime?.() ?? (() => undefined);
      return Object.freeze({ snapshot, release });
    },
    reload(): Promise<ReloadResult> {
      if (reloadPromise !== undefined) {
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
      const startedAt = Date.now();
      const run = (async (): Promise<ReloadResult> => {
        let candidate: ActivePolicySnapshot;
        try {
          candidate = await loader();
        } catch (error) {
          const failureCode = error instanceof PolicyConfigError ? error.code : "policy_invalid";
          emitAudit(options.audit, {
            eventType: "policy_reload",
            actorKind: "internal_reload",
            previousVersion,
            candidateVersion: active.version,
            activeVersion: active.version,
            result: "failed",
            riskIncrease: false,
            workspaceCount: 1,
            bindingCount: 0,
            durationMs: Math.max(0, Date.now() - startedAt)
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

        const prior = active;
        active = candidate;
        retireSnapshotSafely(prior);
        try {
          options.onActivated?.(prior, candidate);
        } catch {
          // Client catalog notification failure cannot roll back an activated policy generation.
        }
        emitAudit(options.audit, {
          eventType: "policy_reload",
          actorKind: "internal_reload",
          previousVersion,
          candidateVersion: candidate.version,
          activeVersion: candidate.version,
          result: "activated",
          riskIncrease: false,
          workspaceCount: 1,
          bindingCount: 0,
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        return {
          activated: true,
          previousVersion,
          activeVersion: candidate.version,
          riskIncrease: false,
          result: "activated"
        };
      })();

      reloadPromise = run.finally(() => {
        reloadPromise = undefined;
      });
      return reloadPromise;
    }
  });
}
