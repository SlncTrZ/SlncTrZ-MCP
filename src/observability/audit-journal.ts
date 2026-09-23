/**
 * Bounded in-memory, export-safe audit journal.
 *
 * This module intentionally accepts only the privacy-reviewed export schema. Callers cannot
 * attach request arguments, output, paths, endpoints, environment data, or credentials.
 */

export type AuditCategory = "auth" | "policy" | "tool" | "control" | "lifecycle";

export type AuditAuthReason =
  | "invalid_owner"
  | "invalid_token"
  | "client_mismatch"
  | "owner_approved"
  | "invalid_request"
  | "unsupported_grant_type"
  | "invalid_client"
  | "invalid_code"
  | "redirect_mismatch"
  | "resource_mismatch"
  | "pkce_mismatch"
  | "invalid_refresh_token"
  | "refresh_rotation_failed"
  | "grant_store_failure"
  | "server_error";

export type AuditAuthOperation =
  "registration" | "authorization" | "token" | "token_exchange" | "owner_authentication";

export interface ExportableAuditEvent {
  readonly timestamp: string;
  readonly category: AuditCategory;
  readonly requestId?: string;
  readonly clientId?: string;
  readonly workspaceId?: string;
  readonly capabilityId?: string;
  readonly commandId?: string;
  readonly providerId?: string;
  readonly correlationId?: string;
  readonly providerFailureClass?: string;
  readonly recoveryState?: string;
  readonly lifecycleReason?: string;
  readonly authReason?: AuditAuthReason;
  readonly authOperation?: AuditAuthOperation;
  readonly policyVersion?: string;
  readonly result: "success" | "error" | "cancelled" | "timeout" | "denied";
  readonly durationMs?: number;
}

export interface AuditJournal {
  append(event: ExportableAuditEvent): void;
  export(options?: { readonly limit?: number }): readonly Readonly<ExportableAuditEvent>[];
}

export function createAuditJournal(options: {
  readonly capacity: number;
  readonly persist?: (event: Readonly<ExportableAuditEvent>) => void;
  readonly onPersistError?: (error: unknown) => void;
}): AuditJournal {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
    throw new Error("Audit journal capacity must be a positive safe integer");
  }

  const events: Readonly<ExportableAuditEvent>[] = [];
  return {
    append(event) {
      const stored = Object.freeze({
        timestamp: event.timestamp,
        category: event.category,
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.clientId === undefined ? {} : { clientId: event.clientId }),
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
        ...(event.capabilityId === undefined ? {} : { capabilityId: event.capabilityId }),
        ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        ...(event.providerId === undefined ? {} : { providerId: event.providerId }),
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.providerFailureClass === undefined
          ? {}
          : { providerFailureClass: event.providerFailureClass }),
        ...(event.recoveryState === undefined ? {} : { recoveryState: event.recoveryState }),
        ...(event.lifecycleReason === undefined ? {} : { lifecycleReason: event.lifecycleReason }),
        ...(event.authReason === undefined ? {} : { authReason: event.authReason }),
        ...(event.authOperation === undefined ? {} : { authOperation: event.authOperation }),
        ...(event.policyVersion === undefined ? {} : { policyVersion: event.policyVersion }),
        result: event.result,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs })
      });
      if (events.length === options.capacity) {
        events.shift();
      }
      events.push(stored);
      if (options.persist !== undefined) {
        try {
          options.persist(stored);
        } catch (error) {
          options.onPersistError?.(error);
        }
      }
    },
    export(exportOptions = {}) {
      const requested = exportOptions.limit ?? events.length;
      if (!Number.isSafeInteger(requested) || requested < 0) {
        throw new Error("Audit journal export limit must be a non-negative safe integer");
      }
      const limit = Math.min(requested, events.length);
      return Object.freeze(events.slice(events.length - limit));
    }
  };
}
