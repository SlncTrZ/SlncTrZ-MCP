/**
 * Extension Adapter Boundary — one isolated third-party MCP provider runtime.
 * Wing: extension | Topic: adapter | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 2.
 *
 * This is the seam between the gateway and a provider. The adapter owns the lifetime of
 * one provider process/endpoint and never runs provider logic in-process. It must not
 * inherit the gateway environment, must not let the caller pick a command, endpoint, or
 * arbitrary argv, and must bound output. Errors map to stable codes so the supervisor can
 * act without leaking command paths, output, or credentials.
 */

import { type RiskClass } from "../kernel/tool-identity.js";

export type AdapterErrorCode =
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_protocol_error"
  | "provider_session_invalid"
  | "queue_overflow";

export type ProviderFailureClass =
  | "session_invalid"
  | "startup_unavailable"
  | "transport_failure"
  | "authorization_failure"
  | "protocol_error"
  | "timeout"
  | "cancelled"
  | "unknown";

export type ProviderRecoveryState = "recovering" | "recovered" | "quarantined";

export interface ProviderDiagnostic {
  readonly correlationId: string;
  readonly failureClass: ProviderFailureClass;
  readonly recoveryState: ProviderRecoveryState;
}

function defaultFailureClass(code: AdapterErrorCode): ProviderFailureClass {
  if (code === "provider_session_invalid") return "session_invalid";
  if (code === "provider_timeout") return "timeout";
  if (code === "provider_protocol_error") return "protocol_error";
  return "unknown";
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly failureClass: ProviderFailureClass;
  readonly diagnostic?: ProviderDiagnostic;

  constructor(
    code: AdapterErrorCode,
    message: string,
    failureClass: ProviderFailureClass = defaultFailureClass(code),
    diagnostic?: ProviderDiagnostic
  ) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.failureClass = failureClass;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

export interface ExtensionToolInfo {
  readonly canonicalId: string;
  readonly exposedName: string;
  readonly riskClass: RiskClass;
  readonly description?: string;
}

export interface ExtensionCallResult {
  readonly isError: boolean;
  readonly truncated: boolean;
  // A caller-facing text result; never raw command output or credentials.
  readonly text: string;
  /** Internal, secret-free incident metadata. Never render this as provider output. */
  readonly diagnostic?: ProviderDiagnostic;
}

export interface AdapterCallOptions {
  readonly signal?: AbortSignal;
}

export type AdapterHealth = "ready" | "degraded" | "unavailable";

/** Internal provider credential material. Never expose these values through MCP/status/audit. */
export type ProviderCredential =
  | { readonly kind: "bearer"; readonly value: string }
  | { readonly kind: "http-header"; readonly name: string; readonly value: string }
  | { readonly kind: "env"; readonly name: string; readonly value: string };

/**
 * One provider runtime. The supervisor owns the lifecycle state machine; an adapter is
 * created already bound to one manifest's fixed command/endpoint and never accepts a
 * calllet-selected command, endpoint, shell string, or argv.
 */
export interface ExtensionAdapter {
  /** Start the provider; resolves when ready, rejects with an {@link AdapterError}. */
  start(): Promise<void>;
  /** Enumerate the provider's declared tools; bounded output. */
  listTools(): Promise<readonly ExtensionToolInfo[]>;
  /** Invoke one canonical tool; cancellable, bounded output, secret-free result. */
  callTool(
    toolId: string,
    args: unknown,
    options: AdapterCallOptions
  ): Promise<ExtensionCallResult>;
  /** Stop the provider and release its child process/connection. */
  stop(): Promise<void>;
  /** Report liveness for the supervisor's health gate. */
  health(): AdapterHealth;
}
