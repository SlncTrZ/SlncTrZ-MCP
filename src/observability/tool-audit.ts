/**
 * Tool Audit — structured attribution without model input or filesystem content.
 * Wing: observability | Topic: tool-audit | Updated: 2026-08-27
 *
 * Provenance: ARCHITECTURE §4.13 and THREAT_MODEL mutation gate.
 */

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
}

export type ToolAuditSink = (event: ToolAuditEvent) => void;

/** Create a JSON-lines sink; event schema cannot carry paths, content, or credentials. */
export function createJsonLineToolAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(line)
): ToolAuditSink {
  return (event) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
