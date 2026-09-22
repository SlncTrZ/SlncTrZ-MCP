/** Stable Debate domain errors for MCP/HTTP adapters. */

export type DebateErrorCode =
  | "invalid_input"
  | "debate_not_found"
  | "membership_invalid"
  | "same_connection_not_allowed"
  | "debate_already_joined"
  | "debate_not_writable"
  | "sequence_conflict"
  | "turn_conflict"
  | "turn_not_acknowledged"
  | "idempotency_conflict"
  | "resume_not_allowed"
  | "delete_not_allowed"
  | "wait_cancelled"
  | "debate_store_closed"
  | "debate_schema_unsupported"
  | "debate_invariant_failed";

export class DebateError extends Error {
  readonly code: DebateErrorCode;

  constructor(code: DebateErrorCode, message: string) {
    super(message);
    this.name = "DebateError";
    this.code = code;
  }
}
