/**
 * MCP Server Factory — creates an isolated, principal-bound protocol server per exchange.
 * Wing: protocol | Topic: mcp-server-factory | Updated: 2026-08-28
 *
 * Provenance: PLAN Phases 1, 3, and 6; ARCHITECTURE request isolation; ADR-006 and ADR-009.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as z from "zod/v4";
import {
  DEFAULT_MAX_EXEC_ARGS,
  HARD_EXEC_OUTPUT_CEILING_BYTES,
  HARD_EXEC_TIMEOUT_CEILING_MS,
  ExecError,
  executeRunCommand,
  startRunCommand,
  type ExecResult
} from "../kernel/exec.js";
import {
  DEFAULT_MAX_EDIT_OPERATIONS,
  type EditOptions,
  type ExactTextEdit,
  EditError,
  editContainedFile
} from "../kernel/fs-edit.js";
import { ExecutionError } from "../kernel/execution.js";
import { DEFAULT_MAX_READ_BYTES, ReadError, readContainedFile } from "../kernel/fs-read.js";
import { isContainedPath, resolveBoundaryRoot } from "../kernel/fs-boundary.js";
import {
  DEFAULT_MAX_SEARCH_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  searchContainedFiles,
  SearchError
} from "../kernel/fs-search.js";
import { type WriteOptions, WriteError, writeContainedFile } from "../kernel/fs-write.js";
import { AdapterError } from "../extension/adapter.js";
import { toolNameOf } from "../kernel/tool-identity.js";
import { buildAgentHarnessInstructions, type AgentHarness } from "../shared/agent-harness.js";
import { APP_VERSION } from "../shared/build-info.js";
import {
  HARD_MAX_TASK_INSTRUCTIONS_BYTES,
  HARD_MAX_TASK_RESULT_BYTES,
  HARD_MAX_TASK_TITLE_CHARS,
  HARD_MAX_TASK_WAIT_MS,
  TaskRuntimeError,
  type TaskRuntime
} from "../task/runtime.js";

/**
 * Build the machine-readable structuredContent for an extension tool result. When the provider
 * returns a JSON text payload it is decoded and merged alongside `truncated`, so structured-first
 * clients surface the actual result instead of only `{ truncated }`. Non-JSON text falls back to
 * the bare `{ truncated }` marker; the raw text always remains in `content[].text`.
 */
export function buildExtensionStructuredContent(
  text: string,
  truncated: boolean
): Record<string, unknown> {
  const base: Record<string, unknown> = { truncated };
  if (text.length === 0) return base;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { truncated, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // text is not JSON
  }
  // Non-JSON payload (or a JSON array/scalar): carry the raw result so a structured-first
  // client still surfaces the actual output instead of only { truncated }.
  return { truncated, text };
}
import { type ToolAuditEvent, type ToolAuditSink } from "../observability/tool-audit.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { observeToolInvocation } from "../observability/tool-invocation.js";
import {
  authorizeKernelCapability,
  authorizeRunKernelCommand,
  createKernelPolicySnapshot,
  KernelPolicyError,
  type AuthenticatedPrincipal,
  type AuthorizedKernelContext,
  type KernelCapability,
  type KernelPolicySnapshot
} from "../policy/kernel-policy.js";
const SERVER_INFO = {
  name: "slnctrz-mcp",
  version: APP_VERSION
} as const;

const NOOP_TOOL_AUDIT: ToolAuditSink = () => undefined;

/** Static gateway metadata surfaced by core.ping so the model can orient itself. */
export interface GatewayInfo {
  readonly version: string;
  readonly buildCommit?: string;
  /** Owner managed config files. These live OUTSIDE the workspace paths (not directly readable). */
  readonly config: {
    readonly policy: string;
    readonly commands: string;
    readonly providers: string;
    readonly audit?: string;
  };
  /** Workspace-relative docs the model should read when they are reachable through core.read. */
  readonly docs: readonly string[];
  /** Optional embedded standalone model guide; surfaced directly by core.ping when no readable file exists. */
  readonly modelGuide?: string;
  /** Product-owned canonical working guidance; never grants capability authority. */
  readonly agentHarness?: AgentHarness;
}

export interface McpServerOptions {
  readonly kernelPolicy?: KernelPolicySnapshot;
  readonly principal?: AuthenticatedPrincipal;
  readonly toolAudit?: ToolAuditSink;
  readonly metrics?: MetricsRegistry;
  /** Public Owner console URL (https://host/owner) for diagnostics/navigation. */
  readonly ownerConsoleUrl?: string;
  /** Static gateway config docs + file locations surfaced by core.ping. */
  readonly gatewayInfo?: GatewayInfo;
  /** Gateway-lifetime in-process task runtime. */
  readonly taskRuntime?: TaskRuntime;
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

function autonomousPath(
  baseRoot: string,
  path: string
): { readonly root: string; readonly relPath: string } {
  if (!isAbsolute(path)) return { root: baseRoot, relPath: path };
  return { root: dirname(path), relPath: basename(path) };
}

function emitToolAuditSafely(sink: ToolAuditSink, event: ToolAuditEvent): void {
  try {
    sink(event);
  } catch {
    return;
  }
}

function errorResult(
  error:
    | ReadError
    | SearchError
    | WriteError
    | EditError
    | ExecError
    | KernelPolicyError
    | ExecutionError
    | TaskRuntimeError
) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }]
  };
}

/** Bucket a requested read path to the bootstrap documentation allowlist (exact or docs/** recurse). */
function isReadAllowed(ctx: AuthorizedKernelContext, path: string): boolean {
  if (ctx.readAllowlist === undefined) return true;
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg !== "." && seg !== "")
    .join("/");
  for (const entry of ctx.readAllowlist) {
    if (entry.endsWith("/**")) {
      const prefix = entry.slice(0, -3).replace(/\/+$/, "");
      if (prefix.length === 0 ? true : normalized.startsWith(`${prefix}/`)) return true;
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

/** Read a file, trying each configured read root until one contains the path. */
async function readWithin(
  roots: readonly string[] | undefined,
  fallback: string,
  path: string,
  maxBytes: number
) {
  const candidates = roots !== undefined && roots.length > 0 ? [...roots] : [fallback];
  let last: ReadError | undefined;
  for (const root of candidates) {
    try {
      return await readContainedFile(root, path, maxBytes);
    } catch (error) {
      if (
        error instanceof ReadError &&
        (error.code === "invalid_path" ||
          error.code === "not_found" ||
          (error.code === "permission_denied" && error.message.includes("Path escapes")))
      ) {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw last ?? new ReadError("not_found", "File not found");
}

interface SearchMatchProvenance {
  readonly root: string;
  readonly path: string;
}

interface RestrictedSearchResult {
  readonly matches: readonly string[];
  readonly resolvedMatches: readonly SearchMatchProvenance[];
  readonly scannedEntries: number;
  readonly truncated: boolean;
}

/** Canonicalize one requested Restricted search root and prove it sits under an authorized Path. */
async function resolveRestrictedSearchRoot(
  roots: readonly string[] | undefined,
  fallback: string,
  requested: string
): Promise<string> {
  const authorizedRoots = roots !== undefined && roots.length > 0 ? [...roots] : [fallback];
  const candidates = isAbsolute(requested)
    ? [requested]
    : authorizedRoots.map((root) => join(root, requested));

  for (const candidate of candidates) {
    let requestedReal: string;
    try {
      requestedReal = await resolveBoundaryRoot(candidate);
    } catch {
      continue;
    }
    for (const authorizedRoot of authorizedRoots) {
      let authorizedReal: string;
      try {
        authorizedReal = await resolveBoundaryRoot(authorizedRoot);
      } catch {
        continue;
      }
      if (isContainedPath(authorizedReal, requestedReal)) return requestedReal;
    }
  }
  throw new SearchError("permission_denied", "Search root is not within an authorized Path");
}

/** Search, merging filename matches across configured read roots under one global budget. */
export async function searchWithin(
  roots: readonly string[] | undefined,
  fallback: string,
  pattern: string,
  maxResults: number,
  maxEntries: number,
  options: { readonly root?: string; readonly signal?: AbortSignal } = {}
): Promise<RestrictedSearchResult> {
  const candidates =
    options.root === undefined
      ? roots !== undefined && roots.length > 0
        ? [...roots]
        : [fallback]
      : [await resolveRestrictedSearchRoot(roots, fallback, options.root)];
  const matches: string[] = [];
  const seenMatches = new Set<string>();
  const resolvedMatches: SearchMatchProvenance[] = [];
  let resultCount = 0;
  let scanned = 0;
  let truncated = false;
  const startedAt = Date.now();
  const timeoutMs = 300_000;

  for (const root of candidates) {
    if (resultCount >= maxResults || scanned >= maxEntries) {
      truncated = true;
      break;
    }
    const remainingTimeout = timeoutMs - Math.max(0, Date.now() - startedAt);
    if (remainingTimeout <= 0) {
      throw new ExecutionError("timeout", "Filesystem search timed out");
    }
    const remainingResults = maxResults - resultCount;
    const remainingEntries = maxEntries - scanned;
    const result = await searchContainedFiles(root, pattern, {
      maxResults: remainingResults,
      maxEntries: remainingEntries,
      timeoutMs: remainingTimeout,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    for (const match of result.matches) {
      resolvedMatches.push({ root, path: match });
      resultCount += 1;
      if (!seenMatches.has(match) && matches.length < maxResults) {
        seenMatches.add(match);
        matches.push(match);
      }
    }
    scanned += result.scannedEntries;
    truncated = truncated || result.truncated;
  }
  return { matches, resolvedMatches, scannedEntries: scanned, truncated };
}

/** Write a file, trying each configured write root until one accepts the path. */
async function writeWithin(
  roots: readonly string[] | undefined,
  fallback: string,
  path: string,
  content: string,
  options: WriteOptions
) {
  const candidates = roots !== undefined && roots.length > 0 ? [...roots] : [fallback];
  let last: WriteError | undefined;
  for (const root of candidates) {
    try {
      return await writeContainedFile(root, path, content, options);
    } catch (error) {
      if (
        error instanceof WriteError &&
        (error.code === "invalid_path" ||
          error.code === "not_found" ||
          (error.code === "permission_denied" && error.message.includes("Path escapes")))
      ) {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw last ?? new WriteError("not_found", "File not found");
}

/** Edit a file, trying each configured write root until one contains the target. */
async function editWithin(
  roots: readonly string[] | undefined,
  fallback: string,
  path: string,
  edits: readonly ExactTextEdit[],
  options: EditOptions
) {
  const candidates = roots !== undefined && roots.length > 0 ? [...roots] : [fallback];
  let last: EditError | undefined;
  for (const root of candidates) {
    try {
      return await editContainedFile(root, path, edits, options);
    } catch (error) {
      if (
        error instanceof EditError &&
        (error.code === "invalid_path" ||
          error.code === "not_found" ||
          (error.code === "permission_denied" && error.message.includes("Path escapes")))
      ) {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw last ?? new EditError("not_found", "File not found");
}

/** Build a fresh MCP server whose tool surface is filtered by principal and policy snapshot. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const agentHarness = options.gatewayInfo?.agentHarness;
  const server = new McpServer(
    SERVER_INFO,
    agentHarness === undefined
      ? undefined
      : { instructions: buildAgentHarnessInstructions(agentHarness) }
  );
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
      description: "Return gateway liveness and the active workspace capability summary.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () =>
      observeToolInvocation(options.metrics, async () => {
        const startedAt = Date.now();
        const kp = options.kernelPolicy;
        const commands = kp?.commandCatalog
          ? kp.commandCatalog.rules.map((rule) =>
              rule.kind === "general"
                ? { command: rule.command }
                : { command: rule.command, subcommands: [...rule.subcommands] }
            )
          : [];
        const workspace = kp
          ? {
              capabilities: [...kp.capabilities],
              // Shared-root model: one Paths set covers read/write/exec for enabled capabilities.
              paths: kp.readRoots ?? [],
              ...(commands.length > 0 ? { commands } : {})
            }
          : { capabilities: [], paths: [] };
        const gi = options.gatewayInfo;
        const config = gi?.config;
        const docs = gi?.docs ?? [];
        const modelGuide = gi?.modelGuide;
        const productAgentHarness = gi?.agentHarness;
        const docsLabel =
          docs.length > 0
            ? docs.join(", ")
            : modelGuide === undefined
              ? "(none)"
              : "embedded docs/MODEL_GUIDE.md (structuredContent.modelGuide)";
        const authorityMode = kp?.authorityMode ?? "restricted";
        const guidance =
          "You are connected to a SlncTrZ-MCP gateway. Active authority mode: " +
          authorityMode +
          ". Your capabilities are under workspace.capabilities. In restricted mode, core file tools " +
          "use configured Paths and core.exec uses the command catalog. In autonomous mode, core tools " +
          "may use the authority of the gateway OS user outside Paths when the task requires it. " +
          "To understand the system, read the workspace docs: " +
          docsLabel +
          ". In source checkouts, model guidance lives in docs/MODEL_GUIDE.md; standalone builds expose the embedded guide in core.ping structuredContent.modelGuide. " +
          (productAgentHarness === undefined
            ? ""
            : "Canonical SlncTrZ working guidance is available in core.ping structuredContent.agentHarness and is product guidance, not capability authority. ") +
          "core.search matches files and directories case-insensitively. " +
          "Gateway config remains owner-managed; do not silently change policy/commands/providers. " +
          "Use the Owner Console" +
          (options.ownerConsoleUrl ? ` at ${options.ownerConsoleUrl}` : "") +
          " for normal configuration changes.";
        const extensionRuntime = kp?.extensionRuntime;
        const configuredProviders = new Set(kp?.extensions.map((tool) => tool.providerId) ?? [])
          .size;
        const readyProviders = new Set(
          kp?.extensions
            .filter((tool) => extensionRuntime?.isReady(tool.providerId) ?? false)
            .map((tool) => tool.providerId) ?? []
        ).size;
        const advertisedExtensionTools =
          kp?.extensions.filter((tool) => extensionRuntime?.isReady(tool.providerId) ?? false)
            .length ?? 0;
        const extensions = {
          configuredProviders,
          readyProviders,
          advertisedTools: advertisedExtensionTools,
          ...(kp?.toolCatalogFingerprint === undefined
            ? {}
            : { catalogFingerprint: kp.toolCatalogFingerprint })
        };
        const text = [
          "SlncTrZ-MCP gateway is online (status: ok).",
          ...(options.ownerConsoleUrl === undefined
            ? []
            : [`Owner console: ${options.ownerConsoleUrl}`]),
          `Workspace: ${JSON.stringify(workspace)}`,
          ...(config === undefined
            ? []
            : [`Config files (outside paths): ${JSON.stringify(config)}`]),
          `Docs to read: ${docsLabel}`,
          guidance
        ].join("\n");
        const response = {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            status: "ok",
            ...(options.ownerConsoleUrl === undefined
              ? {}
              : { ownerConsoleUrl: options.ownerConsoleUrl }),
            ...(gi === undefined
              ? {}
              : {
                  gateway: {
                    version: gi.version,
                    name: "slnctrz-mcp",
                    ...(gi.buildCommit === undefined ? {} : { buildCommit: gi.buildCommit })
                  }
                }),
            workspace: { ...workspace, authorityMode: kp?.authorityMode ?? "restricted" },
            extensions,
            ...(config === undefined ? {} : { config: { ...config } }),
            ...(docs.length === 0 ? {} : { docs: [...docs] }),
            ...(modelGuide === undefined ? {} : { modelGuide }),
            ...(productAgentHarness === undefined ? {} : { agentHarness: productAgentHarness }),
            ...(config === undefined &&
            docs.length === 0 &&
            modelGuide === undefined &&
            productAgentHarness === undefined
              ? {}
              : { guidance })
          }
        };
        emitToolAuditSafely(toolAudit, {
          timestamp: new Date().toISOString(),
          requestId: "core.ping",
          clientId: options.principal?.clientId ?? "unknown",
          workspaceId: kernelPolicy.workspaceId,
          toolId: "core.ping",
          riskClass: "read",
          policyVersion: kernelPolicy.version,
          decision: "allow",
          result: "success",
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        return response;
      })
  );

  const readAuthorization = authorizedContext(kernelPolicy, options.principal, "core.read");
  if (readAuthorization !== undefined) {
    server.registerTool(
      "core.read",
      {
        title: "Read File",
        description:
          "Read a strict UTF-8 file. Autonomous mode also accepts absolute paths outside workspace Paths.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ path: z.string().min(1) })
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const autonomous = readAuthorization.authorityMode === "autonomous";
            if (!autonomous && !isReadAllowed(readAuthorization, args.path)) {
              throw new ReadError(
                "invalid_path",
                "Path is not within the allowed documentation scope"
              );
            }
            const target = autonomousPath(readAuthorization.root, args.path);
            const result = autonomous
              ? await readContainedFile(target.root, target.relPath, DEFAULT_MAX_READ_BYTES, {
                  protectSecrets: false
                })
              : await readWithin(
                  readAuthorization.readRoots,
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
                sha256: result.sha256,
                // Some MCP clients surface structuredContent preferentially; carry the
                // text here too so a read is never reducible to metadata alone.
                content: result.content
              }
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof ReadError || error instanceof ExecutionError) {
              return errorResult(error);
            }
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: readAuthorization.clientId,
              workspaceId: readAuthorization.workspaceId,
              toolId: "core.read",
              riskClass: "read",
              policyVersion: readAuthorization.policyVersion,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );
  }

  const searchAuthorization = authorizedContext(kernelPolicy, options.principal, "core.search");
  if (searchAuthorization !== undefined) {
    server.registerTool(
      "core.search",
      {
        title: "Search Files",
        description:
          "Find filenames. Autonomous mode may search any absolute root accessible to the gateway user.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ pattern: z.string().min(1), root: z.string().optional() })
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const autonomous = searchAuthorization.authorityMode === "autonomous";
            const result = autonomous
              ? await searchContainedFiles(args.root ?? searchAuthorization.root, args.pattern, {
                  maxResults: DEFAULT_MAX_SEARCH_RESULTS,
                  maxEntries: DEFAULT_MAX_SEARCH_ENTRIES,
                  timeoutMs: 300_000,
                  protectSecrets: false,
                  ...(context.http?.req?.signal === undefined
                    ? {}
                    : { signal: context.http.req.signal })
                })
              : await searchWithin(
                  searchAuthorization.readRoots,
                  searchAuthorization.root,
                  args.pattern,
                  DEFAULT_MAX_SEARCH_RESULTS,
                  DEFAULT_MAX_SEARCH_ENTRIES,
                  {
                    ...(args.root === undefined ? {} : { root: args.root }),
                    ...(context.http?.req?.signal === undefined
                      ? {}
                      : { signal: context.http.req.signal })
                  }
                );
            const matches = autonomous
              ? [...result.matches]
              : result.matches.filter((match) => isReadAllowed(searchAuthorization, match));
            return {
              content: [
                {
                  type: "text",
                  text: matches.length === 0 ? "(no matches)" : matches.join("\n")
                }
              ],
              structuredContent: {
                count: matches.length,
                matches,
                ...(!autonomous && "resolvedMatches" in result
                  ? { resolvedMatches: result.resolvedMatches }
                  : {}),
                scannedEntries: result.scannedEntries,
                truncated: result.truncated
              }
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof SearchError || error instanceof ExecutionError) {
              return errorResult(error);
            }
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: searchAuthorization.clientId,
              workspaceId: searchAuthorization.workspaceId,
              toolId: "core.search",
              riskClass: "read",
              policyVersion: searchAuthorization.policyVersion,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );
  }

  const writeAuthorization = authorizedContext(kernelPolicy, options.principal, "core.write");
  if (writeAuthorization !== undefined) {
    server.registerTool(
      "core.write",
      {
        title: "Write File",
        description:
          "Preview or atomically write one UTF-8 file. Autonomous mode also accepts absolute paths outside workspace Paths.",
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
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const autonomous = writeAuthorization.authorityMode === "autonomous";
            const target = autonomousPath(writeAuthorization.root, args.path);
            const writeOptions: WriteOptions = {
              ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
              ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
              ...(context.http?.req?.signal === undefined
                ? {}
                : { signal: context.http.req.signal }),
              ...(autonomous ? { protectSecrets: false } : {})
            };
            const result = autonomous
              ? await writeContainedFile(target.root, target.relPath, args.content, writeOptions)
              : await writeWithin(
                  writeAuthorization.writeRoots,
                  writeAuthorization.root,
                  args.path,
                  args.content,
                  writeOptions
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
        })
    );
  }

  const editAuthorization = authorizedContext(kernelPolicy, options.principal, "core.edit");
  if (editAuthorization !== undefined) {
    server.registerTool(
      "core.edit",
      {
        title: "Edit File",
        description:
          "Apply exact-match replacements to one UTF-8 file. Autonomous mode also accepts absolute paths outside workspace Paths.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z.object({
          path: z.string().min(1),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
          edits: z
            .array(z.object({ oldText: z.string().min(1), newText: z.string() }))
            .min(1)
            .max(DEFAULT_MAX_EDIT_OPERATIONS),
          dryRun: z.boolean().optional()
        })
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const autonomous = editAuthorization.authorityMode === "autonomous";
            const target = autonomousPath(editAuthorization.root, args.path);
            const editOptions: EditOptions = {
              expectedSha256: args.expectedSha256,
              ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
              ...(context.http?.req?.signal === undefined
                ? {}
                : { signal: context.http.req.signal }),
              ...(autonomous ? { protectSecrets: false } : {})
            };
            const result = autonomous
              ? await editContainedFile(target.root, target.relPath, args.edits, editOptions)
              : await editWithin(
                  editAuthorization.writeRoots,
                  editAuthorization.root,
                  args.path,
                  args.edits,
                  editOptions
                );
            return {
              content: [{ type: "text", text: result.applied ? "edit applied" : "dry-run only" }],
              structuredContent: result
            };
          } catch (error) {
            if (error instanceof EditError || error instanceof ExecutionError) {
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
              clientId: editAuthorization.clientId,
              workspaceId: editAuthorization.workspaceId,
              toolId: "core.edit",
              riskClass: "write",
              policyVersion: editAuthorization.policyVersion,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );
  }

  const execAuthorization = authorizedContext(kernelPolicy, options.principal, "core.exec");
  if (execAuthorization !== undefined) {
    server.registerTool(
      "core.exec",
      {
        title: "Execute Command",
        description:
          "Run a command. Restricted mode uses command.json + Paths; autonomous mode uses the gateway user's OS authority.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).max(DEFAULT_MAX_EXEC_ARGS).optional(),
            root: z.string().optional(),
            dryRun: z.boolean().optional(),
            timeoutMs: z.number().int().positive().max(HARD_EXEC_TIMEOUT_CEILING_MS).optional(),
            maxOutputBytes: z
              .number()
              .int()
              .positive()
              .max(HARD_EXEC_OUTPUT_CEILING_BYTES)
              .optional()
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let outcome: ExecResult | undefined;
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "error";
          let auditedCommandId: string | undefined;
          try {
            const authorized = authorizeRunKernelCommand(
              kernelPolicy,
              options.principal,
              args.command,
              (args.args ?? [])[0],
              args.root
            );
            auditedCommandId = authorized.binary;
            const result = await executeRunCommand(
              authorized.binary,
              args.args ?? [],
              authorized.runRoot,
              {
                ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                ...(args.maxOutputBytes === undefined
                  ? {}
                  : { maxOutputBytes: args.maxOutputBytes }),
                ...(context.http?.req?.signal === undefined
                  ? {}
                  : { signal: context.http.req.signal })
              }
            );
            outcome = result;
            const text = result.applied
              ? result.exitCode === null
                ? `terminated by signal ${result.signal ?? ""}`
                : `exit ${result.exitCode}`
              : "dry-run only";
            return {
              content: [{ type: "text", text }],
              structuredContent: result
            };
          } catch (error) {
            if (error instanceof ExecError || error instanceof KernelPolicyError) {
              return errorResult(error);
            }
            throw error;
          } finally {
            if (outcome !== undefined) {
              auditResult = outcome.timedOut
                ? "timeout"
                : outcome.cancelled
                  ? "cancelled"
                  : "success";
            }
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: execAuthorization.clientId,
              workspaceId: execAuthorization.workspaceId,
              toolId: "core.exec",
              riskClass: "execute",
              policyVersion: execAuthorization.policyVersion,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt),
              ...(auditedCommandId === undefined ? {} : { commandId: auditedCommandId })
            });
          }
        })
    );
  }

  const taskRuntime = options.taskRuntime;
  const taskActor =
    taskRuntime === undefined || options.principal === undefined
      ? undefined
      : { clientId: options.principal.clientId, workspaceId: kernelPolicy.workspaceId };

  if (taskRuntime !== undefined && taskActor !== undefined && execAuthorization !== undefined) {
    server.registerTool(
      "task.start",
      {
        title: "Start Managed Task",
        description:
          "Start one policy-authorized command as an in-process managed task and return immediately with a task id.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).max(DEFAULT_MAX_EXEC_ARGS).optional(),
            root: z.string().optional(),
            timeoutMs: z.number().int().positive().max(HARD_EXEC_TIMEOUT_CEILING_MS).optional(),
            maxOutputBytes: z
              .number()
              .int()
              .positive()
              .max(HARD_EXEC_OUTPUT_CEILING_BYTES)
              .optional()
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "error";
          let auditedCommandId: string | undefined;
          try {
            const authorized = authorizeRunKernelCommand(
              kernelPolicy,
              options.principal,
              args.command,
              (args.args ?? [])[0],
              args.root
            );
            auditedCommandId = authorized.binary;
            const task = await taskRuntime.start(taskActor, kernelPolicy.version, () =>
              startRunCommand(authorized.binary, args.args ?? [], authorized.runRoot, {
                ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
                ...(args.maxOutputBytes === undefined
                  ? {}
                  : { maxOutputBytes: args.maxOutputBytes })
              })
            );
            auditResult = "success";
            return {
              content: [{ type: "text", text: `task ${task.taskId} ${task.state}` }],
              structuredContent: task
            };
          } catch (error) {
            if (
              error instanceof ExecError ||
              error instanceof KernelPolicyError ||
              error instanceof TaskRuntimeError
            ) {
              return errorResult(error);
            }
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.start",
              riskClass: "execute",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt),
              ...(auditedCommandId === undefined ? {} : { commandId: auditedCommandId })
            });
          }
        })
    );
  }

  if (taskRuntime !== undefined && taskActor !== undefined) {
    server.registerTool(
      "task.create",
      {
        title: "Create Coordination Task",
        description:
          "Create one workspace-visible logical task for another authenticated client to claim. This does not execute a process.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            title: z.string().min(1).max(HARD_MAX_TASK_TITLE_CHARS),
            instructions: z.string().min(1).max(HARD_MAX_TASK_INSTRUCTIONS_BYTES)
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const task = taskRuntime.create(taskActor, args.title, args.instructions);
            return {
              content: [{ type: "text", text: `task ${task.taskId} ${task.state}` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.create",
              riskClass: "write",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.list",
      {
        title: "List Coordination Tasks",
        description: "List logical coordination tasks visible in the current workspace.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({}).strict()
      },
      async (_args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const tasks = taskRuntime.list(taskActor);
            return {
              content: [{ type: "text", text: `${tasks.length} coordination task(s)` }],
              structuredContent: { tasks }
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.list",
              riskClass: "read",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.claim",
      {
        title: "Claim Coordination Task",
        description: "Atomically claim one available coordination task in the current workspace.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const task = taskRuntime.claim(taskActor, args.taskId);
            return {
              content: [{ type: "text", text: `task ${task.taskId} claimed` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.claim",
              riskClass: "write",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.release",
      {
        title: "Release Coordination Task",
        description: "Release a coordination task currently claimed by this client.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const task = taskRuntime.release(taskActor, args.taskId);
            return {
              content: [{ type: "text", text: `task ${task.taskId} released` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.release",
              riskClass: "write",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.complete",
      {
        title: "Complete Coordination Task",
        description: "Complete a coordination task currently claimed by this client.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            taskId: z.string().min(1),
            result: z.string().min(1).max(HARD_MAX_TASK_RESULT_BYTES)
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const task = taskRuntime.complete(taskActor, args.taskId, args.result);
            return {
              content: [{ type: "text", text: `task ${task.taskId} completed` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.complete",
              riskClass: "write",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.fail",
      {
        title: "Fail Coordination Task",
        description: "Fail a coordination task currently claimed by this client.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            taskId: z.string().min(1),
            failure: z.string().min(1).max(HARD_MAX_TASK_RESULT_BYTES)
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" = "success";
          try {
            const task = taskRuntime.fail(taskActor, args.taskId, args.failure);
            return {
              content: [{ type: "text", text: `task ${task.taskId} failed` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.fail",
              riskClass: "write",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.get",
      {
        title: "Get Managed Task",
        description:
          "Return a creator-private Runner task or any coordination task visible in the current workspace.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const task = taskRuntime.get(taskActor, args.taskId);
            return {
              content: [{ type: "text", text: `task ${task.taskId} ${task.state}` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.get",
              riskClass: "read",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.wait",
      {
        title: "Wait for Managed Task",
        description:
          "Wait for a Runner task up to a bounded request timeout. Cancelling this wait does not cancel the task; coordination tasks use task.get/list instead.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z
          .object({
            taskId: z.string().min(1),
            timeoutMs: z.number().int().positive().max(HARD_MAX_TASK_WAIT_MS).optional()
          })
          .strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const waited = await taskRuntime.wait(taskActor, args.taskId, {
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
              ...(context.http?.req?.signal === undefined
                ? {}
                : { signal: context.http.req.signal })
            });
            return {
              content: [
                {
                  type: "text",
                  text: waited.waitTimedOut
                    ? `task ${waited.task.taskId} still ${waited.task.state}`
                    : `task ${waited.task.taskId} ${waited.task.state}`
                }
              ],
              structuredContent: {
                ...waited.task,
                waitTimedOut: waited.waitTimedOut
              }
            };
          } catch (error) {
            if (error instanceof TaskRuntimeError) {
              auditResult = error.code === "task_wait_cancelled" ? "cancelled" : "error";
              return errorResult(error);
            }
            auditResult = "error";
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.wait",
              riskClass: "read",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );

    server.registerTool(
      "task.cancel",
      {
        title: "Cancel Managed Task",
        description:
          "Cancel a creator-private Runner task, or cancel a coordination task when this client is its creator.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict()
      },
      async (args, context) =>
        observeToolInvocation(options.metrics, async () => {
          const startedAt = Date.now();
          let auditResult: "success" | "error" | "cancelled" | "timeout" = "success";
          try {
            const task = await taskRuntime.cancel(taskActor, args.taskId);
            return {
              content: [{ type: "text", text: `task ${task.taskId} ${task.state}` }],
              structuredContent: task
            };
          } catch (error) {
            auditResult = "error";
            if (error instanceof TaskRuntimeError) return errorResult(error);
            throw error;
          } finally {
            emitToolAuditSafely(toolAudit, {
              timestamp: new Date().toISOString(),
              requestId: String(context.mcpReq.id),
              clientId: taskActor.clientId,
              workspaceId: taskActor.workspaceId,
              toolId: "task.cancel",
              riskClass: "execute",
              policyVersion: kernelPolicy.version,
              decision: "allow",
              result: auditResult,
              durationMs: Math.max(0, Date.now() - startedAt)
            });
          }
        })
    );
  }

  // The per-exchange kernelPolicy is a resolved, captured snapshot. Register only the
  // authorized tools whose provider was ready in that same runtime generation.
  const extensionRuntime = kernelPolicy.extensionRuntime;
  if (extensionRuntime !== undefined) {
    for (const tool of kernelPolicy.extensions) {
      if (!extensionRuntime.isReady(tool.providerId)) continue;
      const provider = extensionRuntime.provider(tool.providerId);
      if (provider === undefined) continue;

      // Surface the provider's real tool description so the model knows what the tool does,
      // plus the owner-provided server description (B) so it knows the server's purpose.
      // Falls back to a generic marker when the provider reports no description.
      const toolDescription = tool.description ?? "Policy-authorized extension tool.";
      const serverDescription = extensionRuntime.registry?.extensions?.find(
        (entry) => entry.id === tool.providerId
      )?.manifest.description;
      const description = serverDescription
        ? `${toolDescription}\n\n[Server: ${serverDescription}]`
        : toolDescription;

      server.registerTool(
        tool.canonicalId,
        {
          title: tool.canonicalId,
          description,
          annotations: {
            readOnlyHint: tool.riskClass === "read",
            destructiveHint: tool.riskClass !== "read",
            idempotentHint: false,
            openWorldHint: tool.riskClass === "network"
          },
          inputSchema: z.object({}).passthrough()
        },
        async (args, context) =>
          observeToolInvocation(options.metrics, async () => {
            const startedAt = Date.now();
            let auditResult: "success" | "error" | "cancelled" | "timeout" = "error";
            try {
              // Re-check readiness immediately before dispatch. No name, endpoint, command or
              // provider selector is accepted from the caller; only this captured canonical tool.
              if (!extensionRuntime.isReady(tool.providerId)) {
                return {
                  isError: true,
                  content: [{ type: "text", text: "provider_unavailable" }]
                };
              }
              const result = await provider.invoke(toolNameOf(tool.canonicalId), args, {
                ...(context.http?.req?.signal === undefined
                  ? {}
                  : { signal: context.http.req.signal })
              });
              auditResult = result.isError
                ? result.text === "provider_timeout"
                  ? "timeout"
                  : "error"
                : "success";
              // Surface the provider's actual payload as machine-readable structuredContent
              // (not just {truncated}) so structured-first clients show the real result.
              const structuredContent = buildExtensionStructuredContent(
                result.text,
                result.truncated
              );
              return {
                isError: result.isError,
                content: [{ type: "text", text: result.text }],
                structuredContent
              };
            } catch (error) {
              if (error instanceof AdapterError) {
                auditResult = error.code === "provider_timeout" ? "timeout" : "error";
                return { isError: true, content: [{ type: "text", text: error.code }] };
              }
              throw error;
            } finally {
              emitToolAuditSafely(toolAudit, {
                timestamp: new Date().toISOString(),
                requestId: String(context.mcpReq.id),
                clientId: options.principal?.clientId ?? "unknown",
                workspaceId: kernelPolicy.workspaceId,
                toolId: tool.canonicalId,
                providerId: tool.providerId,
                canonicalToolId: tool.canonicalId,
                riskClass: tool.riskClass,
                policyVersion: kernelPolicy.version,
                decision: "allow",
                result: auditResult,
                durationMs: Math.max(0, Date.now() - startedAt)
              });
            }
          })
      );
    }
  }

  return server;
}
