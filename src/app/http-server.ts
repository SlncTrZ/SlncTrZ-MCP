/**
 * Public HTTP Server — routes health checks and the MCP data-plane endpoint.
 * Wing: app | Topic: public-http-ingress | Updated: 2026-09-09
 *
 * Provenance: PLAN Phases 1 and 3, SECURITY invariants 1, 7, and 12, ADR-006, and ADR-015.
 */

import type { HarnessRuntime } from "../context/runtime.js";
import type { DebateService } from "../debate/index.js";

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import {
  bearerAuthChallengeResponse,
  verifyBearerToken,
  type AuthInfo,
  type ServerEventBus
} from "@modelcontextprotocol/server";
import { OAuthHttpRouter } from "../auth/oauth-http-router.js";
import { type OAuthService } from "../auth/oauth-service.js";
import { type ToolAuditSink } from "../observability/tool-audit.js";
import { estimateTokensFromBytes } from "../observability/usage-estimator.js";
import type { UsageObserver, UsageRequestKind } from "../observability/usage-types.js";
import type { OwnerWebConsole } from "../owner/web-console.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { createKernelPolicySnapshot, type KernelPolicySnapshot } from "../policy/kernel-policy.js";
import { PolicyConfigError } from "../policy/policy-config.js";
import { type ActivePolicySnapshot } from "../policy/policy-snapshot.js";
import { type PolicySnapshotStore } from "../policy/policy-store.js";
import { createGatewayMcpHandler } from "../protocol/mcp-handler.js";
import type { GatewayInfo } from "../protocol/mcp-server.js";
import type { TaskRuntime } from "../task/runtime.js";
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readBoundedJsonWithSize
} from "../shared/http-body.js";

const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
const DEFAULT_MAX_BODY_BYTES = 16 * 1_048_576;
const MAX_USAGE_TOOL_ID_CHARS = 256;
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
]);

class UnsupportedMcpProtocolVersionError extends Error {
  constructor(readonly requestId: string | number | null) {
    super("Unsupported MCP protocol version");
  }
}

class InvalidMcpRequestError extends Error {
  constructor() {
    super("Invalid MCP request");
  }
}

type GatewayIngressFailureClass =
  | "peer_aborted"
  | "payload_too_large"
  | "invalid_json"
  | "unsupported_media_type"
  | "protocol_error"
  | "server_error";

class GatewayIngressError extends Error {
  constructor(
    readonly failureClass: GatewayIngressFailureClass,
    readonly correlationId: string
  ) {
    super(`gateway_request_error class=${failureClass} correlation_id=${correlationId}`);
    this.name = "GatewayIngressError";
  }
}

function gatewayIngressFailureClass(
  req: IncomingMessage,
  error: unknown
): GatewayIngressFailureClass {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    req.aborted ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    (error instanceof Error && (error.name === "AbortError" || error.message === "aborted"))
  ) {
    return "peer_aborted";
  }
  if (error instanceof PayloadTooLargeError) return "payload_too_large";
  if (error instanceof UnsupportedMediaTypeError) return "unsupported_media_type";
  if (error instanceof SyntaxError) return "invalid_json";
  if (
    error instanceof UnsupportedMcpProtocolVersionError ||
    error instanceof InvalidMcpRequestError
  ) {
    return "protocol_error";
  }
  return "server_error";
}

function safeIngressError(
  req: IncomingMessage,
  error: unknown,
  correlationId: string
): GatewayIngressError {
  if (error instanceof GatewayIngressError && error.correlationId === correlationId) return error;
  return new GatewayIngressError(gatewayIngressFailureClass(req, error), correlationId);
}

export interface GatewayServerOptions {
  readonly oauthService: OAuthService;
  readonly allowedHostnames?: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly kernelPolicy?: KernelPolicySnapshot;
  readonly activePolicy?: ActivePolicySnapshot;
  readonly policyStore?: PolicySnapshotStore;
  readonly ownerWeb?: OwnerWebConsole;
  readonly toolAudit?: ToolAuditSink;
  readonly usageObserver?: UsageObserver;
  readonly ownerConsoleUrl?: string;
  readonly gatewayInfo?: GatewayInfo;
  readonly metrics?: MetricsRegistry;
  readonly mcpEventBus?: ServerEventBus;
  readonly taskRuntime?: TaskRuntime;
  readonly harnessRuntime?: HarnessRuntime;
  readonly debateService?: DebateService;
  readonly onError?: (error: Error) => void;
}

export interface ListenOptions {
  readonly host: string;
  readonly port: number;
}

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

type NormalizedIncomingMessage = IncomingMessage & {
  method: string;
  url: string;
  auth?: AuthInfo;
};

function normalizeRequest(req: IncomingMessage): asserts req is NormalizedIncomingMessage {
  req.method ??= "GET";
  req.url ??= "/";
}

function assertSupportedMcpProtocol(header: string | string[] | undefined, body: unknown): void {
  if (Array.isArray(body)) throw new InvalidMcpRequestError();
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "initialize"
  ) {
    return;
  }
  if (header === undefined) return;
  if (typeof header !== "string" || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(header)) {
    throw new UnsupportedMcpProtocolVersionError(null);
  }
}

function assertSupportedInitializeProtocol(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const request = body as { id?: unknown; method?: unknown; params?: unknown };
  if (request.method !== "initialize") return;
  const params = request.params;
  const protocolVersion =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  if (typeof protocolVersion === "string" && SUPPORTED_MCP_PROTOCOL_VERSIONS.has(protocolVersion)) {
    return;
  }
  const requestId =
    typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
  throw new UnsupportedMcpProtocolVersionError(requestId);
}

function classifyUsageRequest(body: unknown): {
  readonly requestKind: UsageRequestKind;
  readonly toolId?: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { requestKind: "other" };
  }
  const request = body as { method?: unknown; params?: unknown };
  if (request.method === "initialize") return { requestKind: "initialize" };
  if (request.method === "tools/list") return { requestKind: "tools_list" };
  if (request.method === "tools/call") {
    const params = request.params;
    const toolId =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as { name?: unknown }).name
        : undefined;
    return typeof toolId === "string" && toolId.length <= MAX_USAGE_TOOL_ID_CHARS
      ? { requestKind: "tools_call", toolId }
      : { requestKind: "tools_call" };
  }
  return { requestKind: "other" };
}

function responseBodyCounter(res: ServerResponse): () => number {
  let bytes = 0;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const count = (chunk: unknown, encoding?: unknown): void => {
    if (typeof chunk === "string") {
      bytes += Buffer.byteLength(
        chunk,
        typeof encoding === "string" ? (encoding as BufferEncoding) : undefined
      );
    } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
      bytes += chunk.byteLength;
    }
  };
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    count(args[0], args[1]);
    return Reflect.apply(originalWrite, this, args) as boolean;
  } as ServerResponse["write"];
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    count(args[0], args[1]);
    return Reflect.apply(originalEnd, this, args) as ServerResponse;
  } as ServerResponse["end"];
  return () => bytes;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

/** CORS headers exposed to browser MCP clients so they can read auth/session metadata. */
const CORS_EXPOSE_HEADERS =
  "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name";

/** Set cross-origin headers on every response (reference MCP SDK `cors({origin:'*'})` pattern). */
function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name"
  );
}

type ExchangePolicyResolution =
  | { readonly snapshot: KernelPolicySnapshot }
  | { readonly forbidden: { readonly code: string; readonly message: string } };

function denyAllPolicy(): KernelPolicySnapshot {
  return createKernelPolicySnapshot({ workspaceId: "deny-all" });
}

function resolveExchangePolicy(
  activePolicy: ActivePolicySnapshot | undefined,
  kernelPolicy: KernelPolicySnapshot | undefined,
  req: NormalizedIncomingMessage
): ExchangePolicyResolution {
  if (activePolicy === undefined) {
    if (kernelPolicy !== undefined) return { snapshot: kernelPolicy };
    return { snapshot: denyAllPolicy() };
  }
  if (!activePolicy.hasWorkspaces) return { snapshot: denyAllPolicy() };

  const auth = req.auth;
  if (auth === undefined) {
    return { forbidden: { code: "workspace_denied", message: "unauthenticated" } };
  }
  try {
    // Simple product contract: authentication is the only client-to-workspace decision.
    // Workspace/profile selector headers and client bindings are intentionally ignored.
    const snapshot = activePolicy.resolve({ clientId: auth.clientId, scopes: auth.scopes });
    return { snapshot };
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      return { forbidden: { code: "workspace_denied", message: error.message } };
    }
    throw error;
  }
}

/** Construct the public data-plane server without binding a network socket. */
/** The SlncHertine brand font, served once and cached (immutable, static asset). */
const OWNER_FONT_ASSET_PATH = "/assets/fonts/SlncHertine.woff2";

let brandFontBytes: Buffer | undefined;
async function serveBrandFont(res: ServerResponse): Promise<void> {
  if (brandFontBytes === undefined) {
    brandFontBytes = isSea()
      ? Buffer.from(getAsset("SlncHertine.woff2"))
      : await readFile(join(process.cwd(), "src", "assets", "fonts", "SlncHertine.woff2"));
  }
  res.writeHead(200, {
    "content-type": "font/woff2",
    "content-length": brandFontBytes.byteLength,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  });
  res.end(brandFontBytes);
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  const allowedHostnames = [...(options.allowedHostnames ?? DEFAULT_ALLOWED_HOSTNAMES)];
  const allowedOriginHostnames = [...(options.allowedOriginHostnames ?? allowedHostnames)];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("maxBodyBytes must be a positive safe integer");
  }

  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedOriginHostnames);
  const oauthRouter = new OAuthHttpRouter(options.oauthService);

  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 },
    async (req, res) => {
      const correlationId = randomUUID();
      const reportError = (error: unknown): void => {
        options.onError?.(safeIngressError(req, error, correlationId));
      };
      try {
        normalizeRequest(req);
        applyCors(res);
        const pathname = new URL(req.url, "http://localhost").pathname;

        if (req.method === "GET" && pathname === "/healthz") {
          sendJson(res, 200, { status: "ok" });
          return;
        }

        if (req.method === "GET" && pathname === "/readyz") {
          try {
            options.policyStore?.capture();
            sendJson(res, 200, { status: "ready" });
          } catch {
            sendJson(res, 503, { status: "not_ready", code: "policy_unavailable" });
          }
          return;
        }

        if (!validateHost(req, res)) return;
        if (req.method === "GET" && pathname === OWNER_FONT_ASSET_PATH) {
          try {
            await serveBrandFont(res);
          } catch {
            sendJson(res, 404, {
              error: { code: "not_found", message: "Font asset not found" }
            });
          }
          return;
        }
        if (!validateOrigin(req, res)) return;
        if (options.ownerWeb !== undefined && (await options.ownerWeb.handle(req, res, pathname)))
          return;
        if (await oauthRouter.handle(req, res)) return;

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (pathname !== "/mcp") {
          sendJson(res, 404, {
            error: { code: "not_found", message: "Route not found" }
          });
          return;
        }

        try {
          req.auth = await verifyBearerToken(req.headers.authorization, {
            verifier: options.oauthService,
            requiredScopes: ["mcp:tools"],
            resourceMetadataUrl: options.oauthService.resourceMetadataUrl
          });
        } catch (error) {
          await sendResponse(
            res,
            bearerAuthChallengeResponse(error, {
              requiredScopes: ["mcp:tools"],
              resourceMetadataUrl: options.oauthService.resourceMetadataUrl
            })
          );
          return;
        }

        const accessToken = bearerToken(req.headers.authorization);
        if (accessToken === undefined) {
          throw new Error("Verified OAuth request is missing its bearer token");
        }
        const authenticatedConnection =
          await options.oauthService.authenticateConnection(accessToken);

        const captured = options.policyStore?.captureLease();
        let releaseRuntime = captured?.release;
        let resolution: ExchangePolicyResolution;
        try {
          resolution = resolveExchangePolicy(
            captured?.snapshot ?? options.activePolicy,
            options.kernelPolicy,
            req
          );
        } catch (error) {
          releaseRuntime?.();
          throw error;
        }
        if ("forbidden" in resolution) {
          releaseRuntime?.();
          sendJson(res, 403, {
            error: { code: resolution.forbidden.code, message: resolution.forbidden.message }
          });
          return;
        }
        let requestHandler: ReturnType<typeof createGatewayMcpHandler>;
        try {
          requestHandler = createGatewayMcpHandler({
            ...(options.onError === undefined ? {} : { onError: reportError }),
            kernelPolicy: resolution.snapshot,
            ...(options.ownerConsoleUrl === undefined
              ? {}
              : { ownerConsoleUrl: options.ownerConsoleUrl }),
            ...(options.gatewayInfo === undefined ? {} : { gatewayInfo: options.gatewayInfo }),
            ...(options.toolAudit === undefined ? {} : { toolAudit: options.toolAudit }),
            ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
            ...(options.mcpEventBus === undefined ? {} : { eventBus: options.mcpEventBus }),
            ...(options.taskRuntime === undefined ? {} : { taskRuntime: options.taskRuntime }),
            ...(options.harnessRuntime === undefined
              ? {}
              : { harnessRuntime: options.harnessRuntime }),
            authenticatedConnection,
            ...(options.debateService === undefined
              ? {}
              : { debateService: options.debateService }),
            restrictSurfaceProfile: (profile) =>
              options.oauthService.restrictConnection(accessToken, profile)
          });
          releaseRuntime ??= resolution.snapshot.extensionRuntime?.acquire();
        } catch (error) {
          releaseRuntime?.();
          throw error;
        }
        const requestHandleMcp = toNodeHandler(
          requestHandler,
          options.onError === undefined ? {} : { onerror: reportError }
        );
        try {
          const parsed =
            req.method === "POST"
              ? await readBoundedJsonWithSize(req, maxBodyBytes)
              : { value: undefined, bytes: 0 };
          const parsedBody = parsed.value;
          if (options.usageObserver !== undefined) {
            const startedAt = Date.now();
            const usage = classifyUsageRequest(parsedBody);
            const responseBytes = responseBodyCounter(res);
            res.once("finish", () => {
              const outputBytes = responseBytes();
              try {
                options.usageObserver?.traffic({
                  timestamp: new Date(startedAt).toISOString(),
                  workspaceId: resolution.snapshot.workspaceId,
                  requestKind: usage.requestKind,
                  ...(usage.toolId === undefined ? {} : { toolId: usage.toolId }),
                  inputBytes: parsed.bytes,
                  outputBytes,
                  estimatedInputTokens: estimateTokensFromBytes(parsed.bytes),
                  estimatedOutputTokens: estimateTokensFromBytes(outputBytes),
                  durationMs: Math.max(0, Date.now() - startedAt)
                });
              } catch {
                // Usage telemetry is passive and never changes the MCP response.
              }
            });
          }
          assertSupportedMcpProtocol(req.headers["mcp-protocol-version"], parsedBody);
          assertSupportedInitializeProtocol(parsedBody);
          await requestHandleMcp(req, res, parsedBody);
        } finally {
          await requestHandler.close();
          releaseRuntime?.();
        }
      } catch (error) {
        reportError(error);

        if (res.headersSent) {
          res.end();
          return;
        }

        if (error instanceof UnsupportedMcpProtocolVersionError) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            id: error.requestId,
            error: { code: -32602, message: error.message }
          });
          return;
        }

        if (error instanceof InvalidMcpRequestError) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: error.message }
          });
          return;
        }

        if (error instanceof PayloadTooLargeError) {
          sendJson(res, 413, {
            error: { code: "payload_too_large", message: "Request body too large" }
          });
          return;
        }

        if (error instanceof SyntaxError) {
          sendJson(res, 400, {
            error: { code: "invalid_json", message: "Invalid JSON request body" }
          });
          return;
        }

        if (error instanceof UnsupportedMediaTypeError) {
          sendJson(res, 415, {
            error: {
              code: "unsupported_media_type",
              message: "Unsupported request content type"
            }
          });
          return;
        }

        sendJson(res, 500, {
          error: { code: "internal_error", message: "Internal server error" }
        });
      }
    }
  );

  return server;
}

/** Bind a prepared server and return its resolved TCP address. */
export async function listenGateway(
  server: Server,
  options: ListenOptions
): Promise<ListenAddress> {
  return new Promise<ListenAddress>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Gateway did not bind a TCP address"));
        return;
      }
      resolve({ host: address.address, port: address.port });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}
