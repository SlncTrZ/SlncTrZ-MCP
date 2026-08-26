/**
 * Public HTTP Server — routes health checks and the MCP data-plane endpoint.
 * Wing: app | Topic: public-http-ingress | Updated: 2026-08-26
 *
 * Provenance: PLAN Phase 1, SECURITY invariants 7 and 12, and ADR-006.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import {
  bearerAuthChallengeResponse,
  verifyBearerToken,
  type AuthInfo
} from "@modelcontextprotocol/server";
import { OAuthHttpRouter } from "../auth/oauth-http-router.js";
import { type OAuthService } from "../auth/oauth-service.js";
import { createGatewayMcpHandler } from "../protocol/mcp-handler.js";
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readBoundedJson
} from "../shared/http-body.js";

const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface GatewayServerOptions {
  readonly oauthService: OAuthService;
  readonly allowedHostnames?: readonly string[];
  readonly allowedOriginHostnames?: readonly string[];
  readonly maxBodyBytes?: number;
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
const CORS_EXPOSE_HEADERS = "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version";

/** Set cross-origin headers on every response (reference MCP SDK `cors({origin:'*'})` pattern). */
function applyCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, mcp-protocol-version, mcp-session-id"
  );
}

/** Construct the public data-plane server without binding a network socket. */
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
  const errorOptions = options.onError === undefined ? {} : { onError: options.onError };
  const handler = createGatewayMcpHandler(errorOptions);
  const handleMcp = toNodeHandler(
    handler,
    options.onError === undefined ? {} : { onerror: options.onError }
  );

  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 },
    async (req, res) => {
      try {
        normalizeRequest(req);
        applyCors(res);
        const pathname = new URL(req.url, "http://localhost").pathname;

        if (req.method === "GET" && pathname === "/healthz") {
          sendJson(res, 200, { status: "ok" });
          return;
        }

        if (req.method === "GET" && pathname === "/readyz") {
          sendJson(res, 200, { status: "ready" });
          return;
        }

        if (!validateHost(req, res)) return;
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

        if (!validateOrigin(req, res)) return;

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

        const parsedBody =
          req.method === "POST" ? await readBoundedJson(req, maxBodyBytes) : undefined;
        await handleMcp(req, res, parsedBody);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error("Unknown error"));

        if (res.headersSent) {
          res.end();
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

  server.on("close", () => {
    void handler.close();
  });

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
