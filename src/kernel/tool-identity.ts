/**
 * Tool Identity Module — canonical tool names and risk classes.
 * Wing: kernel | Topic: canonical-tool-registry | Updated: 2026-08-26
 *
 * Canonical identities are independent of external naming syntax and runtime
 * topology (ARCHITECTURE §4.5). Collision is a configuration error.
 */

/** Risk class of a tool; drives policy composition and audit classification. */
export type RiskClass = "read" | "write" | "execute" | "network" | "admin";

/** Availability state of a tool as reported by the registry. */
export type ToolAvailability = "ready" | "degraded" | "unavailable";

/** Canonical registry record for a tool (ARCHITECTURE §4.5 ToolRecord). */
export interface ToolRecord {
  readonly canonicalId: string;
  readonly exposedName: string;
  readonly providerId: string;
  readonly schemaHash: string;
  readonly riskClass: RiskClass;
  readonly availability: ToolAvailability;
  readonly version: string;
}

/** Validate that a canonical tool id matches the `provider.tool` shape. */
export function isValidCanonicalId(canonicalId: string): boolean {
  const parts = canonicalId.split(".");
  return parts.length >= 2 && parts.every((part) => part.length > 0);
}

/** Extract the provider prefix (namespace) from a canonical tool id. */
export function providerOf(canonicalId: string): string {
  return canonicalId.split(".")[0] ?? "";
}

/** Extract the trailing tool name from a canonical tool id. */
export function toolNameOf(canonicalId: string): string {
  const parts = canonicalId.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : canonicalId;
}
