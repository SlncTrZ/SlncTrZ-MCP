/**
 * Prediction Seam — gateway-owned CyberBrain Prediction Learning bridge.
 * Wing: extension | Topic: prediction-seam
 *
 * For mutating provider calls the gateway records a transport-level prediction
 * BEFORE dispatch and resolves it AFTER the outcome is known. This preserves
 * the pre-outcome causal order CyberBrain requires; the seam never invents a
 * prediction retrospectively and never lets seam failures break the main call.
 *
 * Safety invariants:
 * - CyberBrain tools are never eligible (no self-recursion).
 * - Read-only tools are never eligible (no learning value, avoid noise).
 * - Caller tool arguments are never echoed into prediction content (secrets).
 * - Every seam failure is swallowed; the main provider call always proceeds.
 */

import { providerOf, type RiskClass } from "../kernel/tool-identity.js";
import type { ExtensionCallResult } from "./adapter.js";
import type { ExtensionProviderRuntime } from "./runtime.js";

/** Canonical provider id of the CyberBrain learning backend. */
export const PREDICTION_SEAM_PROVIDER_ID = "cyberbrain";

/** Transport-level prior: most provider calls complete without provider error. */
export const PREDICTION_SEAM_CONFIDENCE = 0.6;

/** Seam audit outcomes mapped to CyberBrain assessment vocabulary. */
export type SeamAuditResult = "success" | "error" | "cancelled" | "timeout";

export type SeamAssessment = "confirmed" | "contradicted" | "indeterminate";

export function assessmentForAuditResult(result: SeamAuditResult): SeamAssessment {
  if (result === "success") return "confirmed";
  if (result === "error") return "contradicted";
  return "indeterminate";
}

/** True only for mutating calls on non-CyberBrain providers. */
export function isSeamEligible(canonicalId: string, riskClass: RiskClass): boolean {
  if (providerOf(canonicalId) === PREDICTION_SEAM_PROVIDER_ID) return false;
  return riskClass !== "read";
}

export function isSeamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SLNCTRZ_PREDICTION_SEAM_ENABLED === "true";
}

export interface SeamPredictionInput {
  readonly canonicalId: string;
  readonly riskClass: RiskClass;
  readonly clientId: string;
  readonly correlationId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
}

export function buildPredictionArgs(input: SeamPredictionInput): Record<string, unknown> {
  const day = input.now.toISOString().slice(0, 10);
  return {
    expected_outcome:
      `Provider tool ${input.canonicalId} (${input.riskClass}) ` +
      `completes without provider error.`,
    confidence: PREDICTION_SEAM_CONFIDENCE,
    action: input.canonicalId,
    rationale: "Gateway transport-level expectation for a mutating provider call.",
    session_id: `gateway-seam/${input.clientId}/${day}`,
    event_time: input.now.toISOString(),
    topic: "gateway-prediction-seam",
    correlation_id: input.correlationId
  };
}

export function extractPredictionId(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    // Malformed provider payload: no prediction to resolve.
  }
  return undefined;
}

export interface SeamRuntime {
  readonly provider: (providerId: string) => ExtensionProviderRuntime | undefined;
  readonly isReady: (providerId: string) => boolean;
}

/** Each optional learning operation may add at most one second of latency. */
export const PREDICTION_SEAM_TIMEOUT_MS = 1_000;

async function invokeBounded(
  provider: ExtensionProviderRuntime,
  toolId: string,
  args: unknown,
  caller?: AbortSignal
): Promise<ExtensionCallResult | undefined> {
  if (caller?.aborted === true) return undefined;
  const controller = new AbortController();
  let end: () => void = () => undefined;
  const deadline = new Promise<undefined>((resolve) => {
    end = () => {
      controller.abort();
      resolve(undefined);
    };
  });
  const timer = setTimeout(end, PREDICTION_SEAM_TIMEOUT_MS);
  caller?.addEventListener("abort", end, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) return undefined;
        return provider.invoke(toolId, args, { signal: controller.signal });
      }),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", end);
  }
}

/**
 * Record the pre-action prediction. Returns the prediction id or undefined
 * when the seam is disabled, inapplicable, or fails for any reason.
 */
export async function recordSeamPrediction(
  runtime: SeamRuntime,
  input: SeamPredictionInput
): Promise<string | undefined> {
  try {
    if (!isSeamEligible(input.canonicalId, input.riskClass)) return undefined;
    if (!runtime.isReady(PREDICTION_SEAM_PROVIDER_ID)) return undefined;
    const provider = runtime.provider(PREDICTION_SEAM_PROVIDER_ID);
    if (provider === undefined) return undefined;
    const result = await invokeBounded(
      provider,
      "prediction_record",
      buildPredictionArgs(input),
      input.signal
    );
    if (result === undefined || result.isError) return undefined;
    return extractPredictionId(result.text);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a previously recorded prediction. Never throws and never changes
 * the main call outcome.
 */
export async function resolveSeamPrediction(
  runtime: SeamRuntime,
  predictionId: string | undefined,
  auditResult: SeamAuditResult,
  now: Date
): Promise<void> {
  try {
    if (predictionId === undefined) return;
    if (!runtime.isReady(PREDICTION_SEAM_PROVIDER_ID)) return;
    const provider = runtime.provider(PREDICTION_SEAM_PROVIDER_ID);
    if (provider === undefined) return;
    await invokeBounded(provider, "prediction_resolve", {
      prediction_id: predictionId,
      observed_outcome:
        auditResult === "success"
          ? "Provider call completed without provider error."
          : `Provider call ended with audit result: ${auditResult}.`,
      assessment: assessmentForAuditResult(auditResult),
      event_time: now.toISOString()
    });
  } catch {
    // Seam failures must never surface to the caller.
  }
}
