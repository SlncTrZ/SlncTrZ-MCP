/** Shared typed Owner intent. Authentication/CSRF stay at each ingress boundary. */
import type { HostTokenStore } from "../auth/host-token-store.js";

export function manageHostTokens(
  store: HostTokenStore | undefined,
  method: string,
  body?: unknown
): { status: number; body: unknown } {
  if (store === undefined)
    return { status: 503, body: { error: { code: "host_tokens_unavailable" } } };
  if (method === "GET") {
    store.prune();
    return { status: 200, body: { hostTokens: store.list() } };
  }
  const key = method === "POST" ? "label" : method === "DELETE" ? "tokenId" : undefined;
  if (key === undefined) return { status: 405, body: { error: { code: "method_not_allowed" } } };
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { status: 400, body: { error: { code: "invalid_request" } } };
  const record = body as Record<string, unknown>;
  const value = record[key];
  if (
    Object.keys(record).length !== 1 ||
    typeof value !== "string" ||
    (key === "label"
      ? value.trim().length < 1 || value.trim().length > 64
      : !/^[a-f0-9]{24}$/.test(value))
  )
    return { status: 400, body: { error: { code: "invalid_request" } } };
  if (method === "DELETE") return { status: 200, body: { revoked: store.revoke(value) } };
  try {
    store.prune();
    return { status: 201, body: store.issue(value) };
  } catch (error) {
    if (error instanceof Error && error.message === "host_token_capacity")
      return { status: 409, body: { error: { code: "host_token_capacity" } } };
    throw error;
  }
}
