/**
 * MCP HTTP Handler — modern per-request MCP with stateless legacy fallback.
 * Wing: protocol | Topic: streamable-http | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1 and 3, ADR-006, ADR-015, and the public MCP 2026-07-28 transport
 * contract implemented by the official TypeScript SDK v2.
 */

import {
  createMcpHandler,
  type McpHttpHandler,
  type ServerEventBus
} from "@modelcontextprotocol/server";
import { type ToolAuditSink } from "../observability/tool-audit.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { createKernelPolicySnapshot, type KernelPolicySnapshot } from "../policy/kernel-policy.js";
import { createMcpServer, type GatewayInfo } from "./mcp-server.js";
export type { GatewayInfo };

export interface McpHandlerOptions {
  readonly onError?: (error: Error) => void;
  readonly kernelPolicy?: KernelPolicySnapshot;
  readonly toolAudit?: ToolAuditSink;
  readonly metrics?: MetricsRegistry;
  readonly ownerConsoleUrl?: string;
  readonly gatewayInfo?: GatewayInfo;
  readonly eventBus?: ServerEventBus;
}

/** Create one handler whose factory isolates every modern and legacy exchange. */
export function createGatewayMcpHandler(options: McpHandlerOptions = {}): McpHttpHandler {
  const kernelPolicy =
    options.kernelPolicy ??
    createKernelPolicySnapshot({
      workspaceId: "default"
    });

  return createMcpHandler(
    (context) =>
      createMcpServer({
        kernelPolicy,
        ...(options.ownerConsoleUrl === undefined
          ? {}
          : { ownerConsoleUrl: options.ownerConsoleUrl }),
        ...(options.gatewayInfo === undefined ? {} : { gatewayInfo: options.gatewayInfo }),
        ...(context.authInfo === undefined
          ? {}
          : {
              principal: {
                clientId: context.authInfo.clientId,
                scopes: context.authInfo.scopes
              }
            }),
        ...(options.toolAudit === undefined ? {} : { toolAudit: options.toolAudit }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics })
      }),
    {
      legacy: "stateless",
      responseMode: "auto",
      keepAliveMs: 15_000,
      ...(options.eventBus === undefined ? {} : { bus: options.eventBus }),
      ...(options.onError === undefined ? {} : { onerror: options.onError })
    }
  );
}
