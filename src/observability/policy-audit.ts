/**
 * Policy Decision Audit — one secret-free event per startup compile or reload attempt.
 * Wing: observability | Topic: policy-audit | Updated: 2026-08-27
 *
 * Provenance: ARCHITECTURE §4.13, THREAT_MODEL mutation gate, and the Phase 4 handoff slice 4.
 *
 * The event carries aggregated versions, counts, a risk flag and a result — never paths,
 * config text, roots, argv, environment names/values, client binding ids or credentials.
 * A sink failure never undoes an already-completed activation.
 */

export type PolicyAuditResult = "activated" | "rejected" | "approval_required" | "failed";
export type PolicyAuditActorKind = "startup" | "internal_reload";

export interface PolicyAuditEvent {
  readonly timestamp: string;
  readonly eventType: "policy_reload" | "policy_compile";
  readonly actorKind: PolicyAuditActorKind;
  readonly previousVersion: string;
  readonly candidateVersion: string;
  readonly activeVersion: string;
  readonly result: PolicyAuditResult;
  readonly riskIncrease: boolean;
  readonly workspaceCount: number;
  readonly bindingCount: number;
  readonly durationMs: number;
}

export type PolicyAuditSink = (event: PolicyAuditEvent) => void;

/** Serialize one audit event to a single JSON line; the value content is non-secret by schema. */
export function serializePolicyAuditEvent(event: PolicyAuditEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Create a JSON-lines sink; the event schema cannot carry paths, content, or credentials. */
export function createJsonLinePolicyAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(line)
): PolicyAuditSink {
  return (event) => {
    write(serializePolicyAuditEvent(event));
  };
}
