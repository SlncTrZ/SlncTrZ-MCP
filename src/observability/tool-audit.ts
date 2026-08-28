/**
 * Tool Audit — structured attribution without model input or filesystem content.
 * Wing: observability | Topic: tool-audit | Updated: 2026-08-27
 *
 * Provenance: ARCHITECTURE §4.13 and THREAT_MODEL mutation gate.
 */

import type { AuditJournal } from "./audit-journal.js";

export interface ToolAuditEvent {
  readonly timestamp: string;
  readonly requestId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly toolId: string;
  readonly riskClass: "read" | "write" | "execute" | "network" | "admin";
  readonly policyVersion: string;
  readonly decision: "allow" | "deny" | "approve";
  readonly result: "success" | "error" | "cancelled" | "timeout";
  readonly durationMs: number;
  readonly commandId?: string;
  /** Present only for a dispatched extension; no endpoint, arguments or output is retained. */
  readonly providerId?: string;
  readonly canonicalToolId?: string;
}

export type ToolAuditSink = (event: ToolAuditEvent) => void;

export function createJournalToolAuditSink(
  journal: AuditJournal,
  next?: ToolAuditSink
): ToolAuditSink {
  return (event) => {
    journal.append({
      timestamp: event.timestamp,
      category: "tool",
      requestId: event.requestId,
      clientId: event.clientId,
      workspaceId: event.workspaceId,
      capabilityId: event.canonicalToolId ?? event.toolId,
      policyVersion: event.policyVersion,
      result: event.decision === "deny" ? "denied" : event.result,
      durationMs: event.durationMs
    });
    next?.(event);
  };
}

/** Create a JSON-lines sink; event schema cannot carry paths, content, or credentials. */
export function createJsonLineToolAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(line)
): ToolAuditSink {
  return (event) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
