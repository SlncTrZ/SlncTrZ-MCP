/**
 * Application Entry Point — starts the public MCP data plane.
 * Wing: app | Topic: process-entrypoint | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1-3, ADR-012, and ADR-015.
 */

import { OAuthService } from "../auth/oauth-service.js";
import { createJsonLineAuthAuditSink } from "../observability/auth-audit.js";
import { createJsonLineToolAuditSink } from "../observability/tool-audit.js";
import { createKernelPolicySnapshot } from "../policy/kernel-policy.js";
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
const kernelPolicy = createKernelPolicySnapshot({
  workspaceId: "default",
  ...(config.toolRoot === undefined ? {} : { readRoot: config.toolRoot }),
  ...(config.writeRoot === undefined ? {} : { writeRoot: config.writeRoot })
});
const server = createGatewayServer({
  oauthService,
  kernelPolicy,
  toolAudit: createJsonLineToolAuditSink(),
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
