/**
 * Harness MCP Tools — portable bootstrap, catalog and lazy instruction/resource reads.
 * Wing: protocol | Topic: harness-tools | Updated: 2026-09-09
 */

import { type McpServer, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { HarnessError, type HarnessActor } from "../context/discovery.js";
import { HARNESS_GUIDANCE, type HarnessRuntime } from "../context/runtime.js";
import type { AgentHarness } from "../shared/agent-harness.js";
import type { ToolAuditSink } from "../observability/tool-audit.js";

export const HARNESS_TOOLS = [
  "context.bootstrap",
  "context.close",
  "skills.list",
  "skills.read"
] as const;
export const CONTEXT_META_KEY = "org.slnctrz/contextToken";
export const harnessContextShape = {
  slnctrzContext: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "contextToken returned by context.bootstrap; required unless supplied through MCP request metadata."
    )
};

export function contextToken(
  args: { slnctrzContext?: string | undefined },
  context: ServerContext
): string | undefined {
  const meta: unknown = context.mcpReq._meta?.[CONTEXT_META_KEY];
  if (meta !== undefined && (typeof meta !== "string" || meta.length === 0 || meta.length > 128)) {
    throw new HarnessError(
      "context_required",
      "Invalid context token metadata; call context.bootstrap."
    );
  }
  if (
    typeof meta === "string" &&
    args.slnctrzContext !== undefined &&
    args.slnctrzContext !== meta
  ) {
    throw new HarnessError(
      "context_required",
      "Conflicting context tokens; use the receipt for this task."
    );
  }
  return args.slnctrzContext ?? (typeof meta === "string" ? meta : undefined);
}

export function harnessErrorResult(error: HarnessError) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }],
    structuredContent: {
      error: { code: error.code, message: error.message },
      operationExecuted: false
    }
  };
}

export function registerHarnessTools(
  server: McpServer,
  runtime: HarnessRuntime,
  actor: HarnessActor,
  audit: ToolAuditSink,
  productGuidance?: AgentHarness
): void {
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  };
  const statefulAnnotations = {
    ...readAnnotations,
    readOnlyHint: false
  };
  const respond = async (
    name: string,
    context: ServerContext,
    work: () => Promise<Record<string, unknown>>
  ) => {
    const started = Date.now();
    let result: "success" | "error" = "error";
    try {
      const payload = await work();
      result = "success";
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload
      };
    } catch (error) {
      return harnessErrorResult(
        error instanceof HarnessError
          ? error
          : new HarnessError(
              "context_read_failed",
              "Context could not be read safely. Check the configured root, file format and read limits."
            )
      );
    } finally {
      try {
        audit({
          timestamp: new Date().toISOString(),
          requestId: String(context.mcpReq.id),
          clientId: actor.principal.clientId,
          workspaceId: actor.policy.workspaceId,
          toolId: name,
          riskClass: "read",
          policyVersion: actor.policy.version,
          decision: "allow",
          result,
          durationMs: Math.max(0, Date.now() - started)
        });
      } catch {
        /* Audit sink failures must not change tool outcomes. */
      }
    }
  };
  server.registerTool(
    "context.bootstrap",
    {
      title: "Initialize Coding Context",
      description: HARNESS_GUIDANCE,
      annotations: statefulAnnotations,
      inputSchema: z
        .object({
          projectRoot: z
            .string()
            .min(1)
            .max(4096)
            .optional()
            .describe(
              "Optional absolute project directory on the gateway; omit for global-only guidance."
            )
        })
        .strict()
    },
    async (args, context) =>
      respond("context.bootstrap", context, async () => ({
        ...(await runtime.bootstrap(actor, args.projectRoot)),
        ...(productGuidance === undefined ? {} : { productGuidance }),
        tokenMetadataKey: CONTEXT_META_KEY
      }))
  );
  server.registerTool(
    "context.close",
    {
      title: "Release Coding Context",
      description:
        "Release this task's context receipt when finished. Does not cancel tasks or affect other contexts.",
      annotations: statefulAnnotations,
      inputSchema: z.object(harnessContextShape).strict()
    },
    async (args, context) =>
      respond("context.close", context, async () => {
        const token = contextToken(args, context);
        if (token === undefined)
          throw new HarnessError("context_required", "Supply the context receipt to close.");
        return runtime.close(actor, token);
      })
  );
  server.registerTool(
    "skills.list",
    {
      title: "List Available Skills",
      description:
        "Return skill names and descriptions for the active context; no instruction bodies or resources are loaded into the response.",
      annotations: readAnnotations,
      inputSchema: z.object(harnessContextShape).strict()
    },
    async (args, context) =>
      respond("skills.list", context, async () => runtime.list(actor, contextToken(args, context)))
  );
  server.registerTool(
    "skills.read",
    {
      title: "Activate Skill or Read Resource",
      description:
        "Load SKILL.md for a catalog skill before using it. Supply resource only afterward, for one referenced text file relative to that skill. Scripts execute separately through authorized gateway tools.",
      annotations: statefulAnnotations,
      inputSchema: z
        .object({
          ...harnessContextShape,
          name: z.string().min(1).max(64),
          resource: z.string().min(1).max(4096).optional()
        })
        .strict()
    },
    async (args, context) =>
      respond("skills.read", context, async () =>
        runtime.readSkill(actor, contextToken(args, context), args.name, args.resource)
      )
  );
}
