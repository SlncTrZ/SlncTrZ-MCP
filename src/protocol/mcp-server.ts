/**
 * MCP Server Factory — creates an isolated, principal-bound protocol server per exchange.
 * Wing: protocol | Topic: mcp-server-factory | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1 and 3, ARCHITECTURE request isolation, and ADR-006.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ExecutionError } from "../kernel/execution.js";
import { DEFAULT_MAX_READ_BYTES, ReadError, readContainedFile } from "../kernel/fs-read.js";
import {
  DEFAULT_MAX_SEARCH_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  searchContainedFiles,
  SearchError
} from "../kernel/fs-search.js";
import { WriteError, writeContainedFile } from "../kernel/fs-write.js";
import { type ToolAuditEvent, type ToolAuditSink } from "../observability/tool-audit.js";
import {
  authorizeKernelCapability,
  createKernelPolicySnapshot,
  KernelPolicyError,
  type AuthenticatedPrincipal,
  type AuthorizedKernelContext,
  type KernelCapability,
  type KernelPolicySnapshot
} from "../policy/kernel-policy.js";

const SERVER_INFO = {
  name: "slnctrz-mcp",
  version: "0.1.0"
} as const;

const NOOP_TOOL_AUDIT: ToolAuditSink = () => undefined;

export interface McpServerOptions {
  readonly kernelPolicy?: KernelPolicySnapshot;
  readonly principal?: AuthenticatedPrincipal;
  readonly toolAudit?: ToolAuditSink;
}

function authorizedContext(
  snapshot: KernelPolicySnapshot,
  principal: AuthenticatedPrincipal | undefined,
  capability: KernelCapability
): AuthorizedKernelContext | undefined {
  try {
    return authorizeKernelCapability(snapshot, principal, capability);
  } catch (error) {
    if (error instanceof KernelPolicyError) return undefined;
    throw error;
  }
}

function emitToolAuditSafely(sink: ToolAuditSink, event: ToolAuditEvent): void {
  try {
    sink(event);
  } catch {
    return;
  }
}

function errorResult(error: ReadError | SearchError | WriteError | ExecutionError) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }]
  };
}

/** Build a fresh MCP server whose tool surface is filtered by principal and policy snapshot. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO);
  const kernelPolicy =
    options.kernelPolicy ??
    createKernelPolicySnapshot({
      workspaceId: "default"
    });
  const toolAudit = options.toolAudit ?? NOOP_TOOL_AUDIT;

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

  const readAuthorization = authorizedContext(kernelPolicy, options.principal, "core.read");
  if (readAuthorization !== undefined) {
    server.registerTool(
      "core.read",
      {
        title: "Read File",
        description: "Read a strict UTF-8 file within the policy-authorized read root.",
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
          const result = await readContainedFile(
            readAuthorization.root,
            args.path,
            DEFAULT_MAX_READ_BYTES
          );
          return {
            content: [{ type: "text", text: result.content }],
            structuredContent: {
              path: args.path,
              bytes: result.bytes,
              encoding: result.encoding,
              sha256: result.sha256
            }
          };
        } catch (error) {
          if (error instanceof ReadError || error instanceof ExecutionError) {
            return errorResult(error);
          }
          throw error;
        }
      }
    );
  }

  const searchAuthorization = authorizedContext(kernelPolicy, options.principal, "core.search");
  if (searchAuthorization !== undefined) {
    server.registerTool(
      "core.search",
      {
        title: "Search Files",
        description: "Find filenames within the policy-authorized read root.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ pattern: z.string().min(1) })
      },
      async (args) => {
        try {
          const result = await searchContainedFiles(searchAuthorization.root, args.pattern, {
            maxResults: DEFAULT_MAX_SEARCH_RESULTS,
            maxEntries: DEFAULT_MAX_SEARCH_ENTRIES
          });
          return {
            content: [
              {
                type: "text",
                text: result.matches.length === 0 ? "(no matches)" : result.matches.join("\n")
              }
            ],
            structuredContent: {
              count: result.matches.length,
              matches: result.matches,
              scannedEntries: result.scannedEntries,
              truncated: result.truncated
            }
          };
        } catch (error) {
          if (error instanceof SearchError || error instanceof ExecutionError) {
            return errorResult(error);
          }
          throw error;
        }
      }
    );
  }

  const writeAuthorization = authorizedContext(kernelPolicy, options.principal, "core.write");
  if (writeAuthorization !== undefined) {
    server.registerTool(
      "core.write",
      {
        title: "Write File",
        description:
          "Preview or atomically write one UTF-8 file within the policy-authorized write root.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z.object({
          path: z.string().min(1),
          content: z.string(),
          dryRun: z.boolean().optional(),
          expectedSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/iu)
            .optional()
        })
      },
      async (args, context) => {
        const startedAt = Date.now();
        let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
        try {
          const result = await writeContainedFile(
            writeAuthorization.root,
            args.path,
            args.content,
            {
              ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
              ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
              ...(context.http?.req?.signal === undefined
                ? {}
                : { signal: context.http.req.signal })
            }
          );
          return {
            content: [
              {
                type: "text",
                text: result.applied ? "write applied" : "dry-run only"
              }
            ],
            structuredContent: result
          };
        } catch (error) {
          if (error instanceof WriteError || error instanceof ExecutionError) {
            auditResult =
              error.code === "cancelled"
                ? "cancelled"
                : error.code === "timeout"
                  ? "timeout"
                  : "error";
            return errorResult(error);
          }
          auditResult = "error";
          throw error;
        } finally {
          emitToolAuditSafely(toolAudit, {
            timestamp: new Date().toISOString(),
            requestId: String(context.mcpReq.id),
            clientId: writeAuthorization.clientId,
            workspaceId: writeAuthorization.workspaceId,
            toolId: "core.write",
            riskClass: "write",
            policyVersion: writeAuthorization.policyVersion,
            decision: "allow",
            result: auditResult,
            durationMs: Math.max(0, Date.now() - startedAt)
          });
        }
      }
    );
  }

  return server;
}
