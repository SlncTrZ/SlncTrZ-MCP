/**
 * MCP Server Factory — creates an isolated protocol server for each exchange.
 * Wing: protocol | Topic: mcp-server-factory | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 1, ARCHITECTURE request-context isolation, and the
 * public MCP TypeScript SDK v2 contract.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DEFAULT_MAX_READ_BYTES, ReadError, readContainedFile } from "../kernel/fs-read.js";

const SERVER_INFO = {
  name: "slnctrz-mcp",
  version: "0.1.0"
} as const;

export interface McpServerOptions {
  readonly toolRoot?: string;
}

/** Build a fresh MCP server so negotiated state cannot cross client boundaries. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
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

  server.registerTool(
    "core.read",
    {
      title: "Read File",
      description: "Read a UTF-8 file within the configured filesystem root.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: z.object({ path: z.string().min(1) })
    },
    async (args) => {
      try {
        const result = await readContainedFile(options.toolRoot, args.path, DEFAULT_MAX_READ_BYTES);
        return {
          content: [{ type: "text", text: result.content }],
          structuredContent: {
            path: args.path,
            bytes: result.bytes,
            encoding: result.encoding
          }
        };
      } catch (error) {
        if (error instanceof ReadError) {
          return {
            isError: true,
            content: [{ type: "text", text: `${error.code}: ${error.message}` }]
          };
        }
        throw error;
      }
    }
  );

  return server;
}
