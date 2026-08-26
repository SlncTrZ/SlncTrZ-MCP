/**
 * MCP HTTP Handler — modern per-request MCP with stateless legacy fallback.
 * Wing: protocol | Topic: streamable-http | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 1, ADR-006, and the public MCP 2026-07-28 transport
 * contract implemented by the official TypeScript SDK v2.
 */

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "./mcp-server.js";

export interface McpHandlerOptions {
  readonly onError?: (error: Error) => void;
  readonly toolRoot?: string;
}

/** Create one handler whose factory isolates every modern and legacy exchange. */
export function createGatewayMcpHandler(options: McpHandlerOptions = {}): McpHttpHandler {
  return createMcpHandler(
    () =>
      createMcpServer({
        ...(options.toolRoot === undefined ? {} : { toolRoot: options.toolRoot })
      }),
    {
      legacy: "stateless",
      responseMode: "auto",
      keepAliveMs: 15_000,
      ...(options.onError === undefined ? {} : { onerror: options.onError })
    }
  );
}
