/**
 * Application Entry Point — starts the public MCP data plane.
 * Wing: app | Topic: process-entrypoint | Updated: 2026-08-26
 *
 * Provenance: PLAN Phases 1-2 and ADR-012.
 */

import { OAuthService } from "../auth/oauth-service.js";
import { createJsonLineAuthAuditSink } from "../observability/auth-audit.js";
import { readRuntimeConfig } from "./config.js";
import { createGatewayServer, listenGateway } from "./http-server.js";

const config = readRuntimeConfig();
let issuer: URL;
try {
  issuer = new URL(config.publicMcpUrl.origin);
} catch {
  throw new Error("Invalid issuer URL");
}

const oauthService = new OAuthService({
  issuer,
  resource: config.publicMcpUrl,
  ownerSecretHash: config.ownerSecretHash,
  maxDynamicClients: config.maxDynamicClients,
  audit: createJsonLineAuthAuditSink(),
  ...(config.staticClient === undefined ? {} : { staticClient: config.staticClient })
});
const server = createGatewayServer({
  oauthService,
  allowedHostnames: config.allowedHostnames,
  allowedOriginHostnames: config.allowedOriginHostnames,
  onError: (error) => {
    console.error(error.message);
  }
});

const address = await listenGateway(server, {
  host: config.host,
  port: config.port
});

console.log(`SlncTrZ-MCP listening on http://${address.host}:${address.port}/mcp`);
