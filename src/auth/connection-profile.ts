/** Internal connection policy; deliberately separate from MCP SDK AuthInfo. */
export type SurfaceProfile = "full" | "gateway-only";
export interface AuthenticatedConnection {
  readonly clientId: string;
  readonly grantId: string;
  /** Stable connection identity, currently the OAuth grant ID (not an MCP transport session). */
  readonly connectionId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly surfaceProfile: SurfaceProfile;
}
export function validateSurfaceProfile(value: unknown): SurfaceProfile {
  if (value !== "full" && value !== "gateway-only") throw new Error("invalid_surface_profile");
  return value;
}
export function resolveSurfaceProfile(
  grantOverride?: SurfaceProfile,
  clientDefault?: SurfaceProfile
): SurfaceProfile {
  if (grantOverride !== undefined) validateSurfaceProfile(grantOverride);
  if (clientDefault !== undefined) validateSurfaceProfile(clientDefault);
  return grantOverride ?? clientDefault ?? "full";
}
const GATEWAY_BUILTINS = new Set([
  "core.ping",
  "connection.restrict",
  "debate.create",
  "debate.join",
  "debate.read",
  "debate.send",
  "debate.wait",
  "debate.stop"
]);
/** Apply to both tools/list and dispatch, in addition to existing policy/capability checks.
 * source MUST come from the server registry, never from caller arguments or a name heuristic.
 */
export function isToolVisibleForProfile(
  profile: SurfaceProfile,
  tool: { readonly name: string; readonly source: "builtin" | "provider" }
): boolean {
  validateSurfaceProfile(profile);
  if (tool.source !== "builtin" && tool.source !== "provider") return false;
  return profile === "full" || tool.source === "provider" || GATEWAY_BUILTINS.has(tool.name);
}
