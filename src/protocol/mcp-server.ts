/**
 * MCP Server Factory — creates an isolated protocol server for each exchange.
 * Wing: protocol | Topic: mcp-server-factory | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 1, ARCHITECTURE request-context isolation, and the
 * public MCP TypeScript SDK v2 contract.
 */

import { McpServer } from "@modelcontextprotocol/server";

const SERVER_INFO = {
  name: "slnctrz-mcp",
  version: "0.1.0"
} as const;

/** Build a fresh MCP server so negotiated state cannot cross client boundaries. */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "core.ping",
    {
      title: "Gateway Ping",
      description: "Return a deterministic gateway liveness response.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => ({
      content: [{ type: "text", text: "pong" }],
      structuredContent: { status: "ok" }
    })
  );

  return server;
}
