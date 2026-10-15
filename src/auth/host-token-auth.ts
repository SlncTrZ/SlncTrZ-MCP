/** ADR-030: hard-coded authority ceiling, independent of OAuth grant defaults. */
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { AuthenticatedConnection } from "./connection-profile.js";
import type { HostTokenStore } from "./host-token-store.js";

export function authenticateHostToken(
  store: HostTokenStore | undefined,
  token: string,
  resource: URL
): { auth: AuthInfo; connection: AuthenticatedConnection } {
  const metadata = store?.authenticate(token);
  if (metadata === undefined)
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
  const identity = `host:${metadata.tokenId}`;
  return {
    auth: { token, clientId: identity, scopes: ["mcp:tools"], resource },
    connection: {
      clientId: identity,
      grantId: identity,
      connectionId: identity,
      scopes: ["mcp:tools"],
      resource: resource.href,
      surfaceProfile: "gateway-only",
      resultDelivery: "structured"
    }
  };
}
