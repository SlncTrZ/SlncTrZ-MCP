/**
 * Authentication Audit — structured, secret-free security events.
 * Wing: observability | Topic: authentication-audit | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 2 acceptance criteria and SECURITY invariant 10.
 */

import type { AuditAuthOperation, AuditAuthReason, AuditJournal } from "./audit-journal.js";
import type { MetricsRegistry } from "./metrics.js";

export type AuthAuditEventType =
  | "client.registered"
  | "client.evicted"
  | "client.persistence_failed"
  | "static_client.redirect_registered"
  | "authorization.approved"
  | "authorization.denied"
  | "authorization.failed"
  | "token.issued"
  | "token.refreshed"
  | "token.revoked"
  | "token.rejected"
  | "token.exchange_rejected"
  | "rate_limit.triggered";

export type AuthAuditOutcome = "success" | "failure" | "ignored";

export type AuthAuditReason = AuditAuthReason;
export type AuthAuditOperation = AuditAuthOperation;

export interface AuthAuditEvent {
  readonly timestamp: string;
  readonly type: AuthAuditEventType;
  readonly outcome: AuthAuditOutcome;
  readonly clientId?: string;
  readonly reason?: AuthAuditReason;
  readonly operation?: AuthAuditOperation;
}

export type AuthAuditSink = (event: AuthAuditEvent) => void;

export function createJournalAuthAuditSink(
  journal: AuditJournal,
  next?: AuthAuditSink,
  metrics?: MetricsRegistry
): AuthAuditSink {
  return (event) => {
    const denied = event.type === "authorization.denied";
    journal.append({
      timestamp: event.timestamp,
      category: "auth",
      ...(event.clientId === undefined ? {} : { clientId: event.clientId }),
      capabilityId: event.type,
      ...(event.reason === undefined ? {} : { authReason: event.reason }),
      ...(event.operation === undefined ? {} : { authOperation: event.operation }),
      result: denied ? "denied" : event.outcome === "success" ? "success" : "error"
    });
    if (event.outcome === "failure") metrics?.authFailed();
    next?.(event);
  };
}

/** Create a JSON-lines sink. Callers own destination permissions and rotation. */
export function createJsonLineAuthAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(line)
): AuthAuditSink {
  return (event) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
