/**
 * Application Entry Point — starts the public MCP data plane.
 * Wing: app | Topic: process-entrypoint | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1-3, ADR-012, and ADR-015.
 */

import { readFileSync } from "node:fs";
import { OAuthService } from "../auth/oauth-service.js";
import {
  type ExecCommandDefinition,
  parseExecCommandRegistry,
  validateExecCommandRegistry
} from "../kernel/exec.js";
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
let execRoot: string | undefined;
let execCommands: readonly ExecCommandDefinition[] | undefined;
if (config.execRoot !== undefined && config.execCommandsFile !== undefined) {
  let rawRegistry: unknown;
  try {
    rawRegistry = JSON.parse(readFileSync(config.execCommandsFile, "utf8"));
  } catch {
    throw new Error(`Could not parse exec command registry: ${config.execCommandsFile}`);
  }
  const parsedCommands = parseExecCommandRegistry(rawRegistry);
  const validated = await validateExecCommandRegistry(config.execRoot, parsedCommands);
  execRoot = validated.execRootReal;
  execCommands = validated.commands;
}

const kernelPolicy = createKernelPolicySnapshot({
  workspaceId: "default",
  ...(config.toolRoot === undefined ? {} : { readRoot: config.toolRoot }),
  ...(config.writeRoot === undefined ? {} : { writeRoot: config.writeRoot }),
  ...(execRoot === undefined ? {} : { execRoot }),
  ...(config.execPath === undefined ? {} : { execPath: config.execPath }),
  ...(execCommands === undefined ? {} : { execCommands })
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
