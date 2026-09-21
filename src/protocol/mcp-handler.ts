/**
 * MCP HTTP Handler — modern per-request MCP with stateless legacy fallback.
 * Wing: protocol | Topic: streamable-http | Updated: 2026-09-09
 *
 * Provenance: PLAN Phases 1 and 3, ADR-006, ADR-015, and the public MCP 2026-07-28 transport
 * contract implemented by the official TypeScript SDK v2.
 */

import type { AuthenticatedConnection, SurfaceProfile } from "../auth/connection-profile.js";
import type { HarnessRuntime } from "../context/runtime.js";
import type { DebateService } from "../debate/index.js";

import {
  createMcpHandler,
  type McpHttpHandler,
  type ServerEventBus
} from "@modelcontextprotocol/server";
import { type ToolAuditSink } from "../observability/tool-audit.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { createKernelPolicySnapshot, type KernelPolicySnapshot } from "../policy/kernel-policy.js";
import type { TaskRuntime } from "../task/runtime.js";
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
  readonly taskRuntime?: TaskRuntime;
  readonly harnessRuntime?: HarnessRuntime;
  readonly authenticatedConnection?: AuthenticatedConnection;
  readonly debateService?: DebateService;
  readonly restrictSurfaceProfile?: (profile: SurfaceProfile) => AuthenticatedConnection;
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
        ...(options.authenticatedConnection === undefined
          ? context.authInfo === undefined
            ? {}
            : {
                principal: {
                  clientId: context.authInfo.clientId,
                  scopes: context.authInfo.scopes
                }
              }
          : {
              authenticatedConnection: options.authenticatedConnection,
              principal: {
                clientId: options.authenticatedConnection.clientId,
                scopes: [...options.authenticatedConnection.scopes]
              }
            }),
        ...(options.toolAudit === undefined ? {} : { toolAudit: options.toolAudit }),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        ...(options.taskRuntime === undefined ? {} : { taskRuntime: options.taskRuntime }),
        ...(options.harnessRuntime === undefined ? {} : { harnessRuntime: options.harnessRuntime }),
        ...(options.debateService === undefined ? {} : { debateService: options.debateService }),
        ...(options.restrictSurfaceProfile === undefined
          ? {}
          : { restrictSurfaceProfile: options.restrictSurfaceProfile })
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
