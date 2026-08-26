/**
 * Authentication Audit — structured, secret-free security events.
 * Wing: observability | Topic: authentication-audit | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 2 acceptance criteria and SECURITY invariant 10.
 */

export type AuthAuditEventType =
  | "client.registered"
  | "authorization.approved"
  | "authorization.denied"
  | "authorization.failed"
  | "token.issued"
  | "token.refreshed"
  | "token.revoked"
  | "token.rejected"
  | "rate_limit.triggered";

export type AuthAuditOutcome = "success" | "failure" | "ignored";

export interface AuthAuditEvent {
  readonly timestamp: string;
  readonly type: AuthAuditEventType;
  readonly outcome: AuthAuditOutcome;
  readonly clientId?: string;
  readonly reason?: "invalid_owner" | "invalid_token" | "client_mismatch";
  readonly operation?: "registration" | "token" | "owner_authentication";
}

export type AuthAuditSink = (event: AuthAuditEvent) => void;

/** Create a JSON-lines sink. Callers own destination permissions and rotation. */
export function createJsonLineAuthAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(line)
): AuthAuditSink {
  return (event) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
