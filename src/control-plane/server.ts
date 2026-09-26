/** Loopback-only local diagnostics and revocation control plane. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { validateConnectionLabel } from "../auth/oauth-grant-store.js";
import type { OwnerConnectionService } from "../auth/owner-connection-service.js";
import { verifyOwnerSecret } from "../auth/owner-verifier.js";
import type { OAuthService } from "../auth/oauth-service.js";
import type { AuditJournal } from "../observability/audit-journal.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { PolicySnapshotStore } from "../policy/policy-store.js";
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readBoundedJson
} from "../shared/http-body.js";

const MAX_CONTROL_BODY_BYTES = 65_536;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface ControlPlaneOptions {
  readonly ownerSecretHash: string;
  readonly oauthService: Pick<OAuthService, "revokeClientByOwner" | "revokeTokenByOwner">;
  readonly policyStore: Pick<PolicySnapshotStore, "capture" | "reload">;
  readonly connections?: Pick<
    OwnerConnectionService,
    "listConnections" | "setGrantProfile" | "setClientDefault" | "setConnectionLabel"
  >;
  readonly auditJournal: AuditJournal;
  readonly metrics?: MetricsRegistry;
  readonly gatewayInfo?: { readonly version: string; readonly buildCommit: string };
  readonly maxBodyBytes?: number;
  readonly onError?: (error: Error) => void;
}

export interface ControlListenOptions {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface ControlListenAddress {
  readonly host: string;
  readonly port: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function sendRateLimit(res: ServerResponse, retryAfterSeconds: number): void {
  const payload = JSON.stringify({
    error: { code: "rate_limited", message: "Too many failed Owner authentication attempts" }
  });
  res.writeHead(429, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "retry-after": String(Math.max(1, retryAfterSeconds)),
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (value === undefined || !value.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length);
}

function exactStringBody(body: unknown, key: string, maxLength: number): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record[key] !== "string") return undefined;
  const value = record[key];
  return value.length > 0 && value.length <= maxLength ? value : undefined;
}

function profileMutationBody(
  body: unknown,
  idKey: "grantId" | "clientId"
): { readonly id: string; readonly profile: "full" | "gateway-only" } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record[idKey] !== "string" ||
    (record.surfaceProfile !== "full" && record.surfaceProfile !== "gateway-only")
  )
    return undefined;
  const id = record[idKey];
  if (id.length < 1 || id.length > 256) return undefined;
  return { id, profile: record.surfaceProfile };
}

function authorized(req: IncomingMessage, ownerSecretHash: string): boolean {
  const secret = bearer(req);
  return secret !== undefined && verifyOwnerSecret(secret, ownerSecretHash);
}

export function createControlPlaneServer(options: ControlPlaneOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CONTROL_BODY_BYTES;
  const ownerFailureLimiter = new FixedWindowRateLimiter({ limit: 10, windowSeconds: 60 });
  return createServer((req, res) => {
    void (async () => {
      const startedAt = Date.now();
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const audit = (
        result: "success" | "error" | "denied",
        capabilityId = `control:${method}:${pathname}`
      ): void => {
        options.auditJournal.append({
          timestamp: new Date().toISOString(),
          category: "control",
          capabilityId,
          result,
          durationMs: Math.max(0, Date.now() - startedAt)
        });
      };

      const peerKey = req.socket.remoteAddress ?? "unknown";
      const ownerBudget = ownerFailureLimiter.check(peerKey);
      if (!ownerBudget.allowed) {
        sendRateLimit(res, ownerBudget.retryAfterSeconds);
        audit("denied");
        return;
      }

      if (!authorized(req, options.ownerSecretHash)) {
        ownerFailureLimiter.consume(peerKey);
        sendJson(res, 401, {
          error: { code: "unauthorized", message: "Owner authentication required" }
        });
        audit("denied");
        return;
      }

      if (method === "GET" && pathname === "/status") {
        const snapshot = options.policyStore.capture();
        sendJson(res, 200, {
          status: "ok",
          policyVersion: snapshot.version,
          workspaceCount: 1,
          authorityMode: snapshot.normalized.kernelPolicy.authorityMode,
          ...(options.gatewayInfo === undefined ? {} : options.gatewayInfo)
        });
        audit("success");
        return;
      }

      if (method === "GET" && pathname === "/policy") {
        const snapshot = options.policyStore.capture();
        sendJson(res, 200, {
          policyVersion: snapshot.version,
          paths: snapshot.normalized.kernelPolicy.readRoots ?? [],
          capabilities: snapshot.normalized.kernelPolicy.capabilities
        });
        audit("success");
        return;
      }

      if (method === "POST" && pathname === "/policy/reload") {
        const result = await options.policyStore.reload();
        sendJson(res, result.activated ? 200 : 409, result);
        audit(result.activated ? "success" : "error");
        return;
      }

      if (method === "GET" && pathname === "/connections") {
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          audit("error");
          return;
        }
        sendJson(res, 200, { connections: options.connections.listConnections() });
        audit("success");
        return;
      }

      if (
        method === "PUT" &&
        (pathname === "/connections/profile" || pathname === "/connections/default")
      ) {
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          audit("error");
          return;
        }
        const grantMutation = pathname === "/connections/profile";
        const parsed = profileMutationBody(
          await readBoundedJson(req, maxBodyBytes),
          grantMutation ? "grantId" : "clientId"
        );
        if (parsed === undefined) {
          sendJson(res, 400, {
            error: { code: "invalid_request", message: "Expected connection profile mutation" }
          });
          audit("error");
          return;
        }
        if (grantMutation) options.connections.setGrantProfile(parsed.id, parsed.profile);
        else options.connections.setClientDefault(parsed.id, parsed.profile);
        sendJson(
          res,
          200,
          grantMutation
            ? { grantId: parsed.id, surfaceProfile: parsed.profile }
            : { clientId: parsed.id, surfaceProfile: parsed.profile }
        );
        audit("success");
        return;
      }

      if (method === "PUT" && pathname === "/connections/label") {
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          audit("error");
          return;
        }
        const body = (await readBoundedJson(req, maxBodyBytes)) as {
          grantId?: unknown;
          label?: unknown;
        };
        if (
          typeof body.grantId !== "string" ||
          body.grantId.length < 1 ||
          body.grantId.length > 256
        ) {
          sendJson(res, 400, {
            error: { code: "invalid_request", message: "Expected grantId and label" }
          });
          audit("error");
          return;
        }
        let label: string;
        try {
          label = validateConnectionLabel(body.label);
        } catch {
          sendJson(res, 400, {
            error: { code: "invalid_label", message: "Label must be 1-64 characters" }
          });
          audit("error");
          return;
        }
        try {
          options.connections.setConnectionLabel(body.grantId, label);
        } catch (error) {
          if (error instanceof Error && error.message === "oauth_grant_not_found") {
            sendJson(res, 404, {
              error: { code: "unknown_grant", message: "Connection grant no longer exists" }
            });
            audit("error");
            return;
          }
          throw error;
        }
        sendJson(res, 200, { grantId: body.grantId, label });
        audit("success");
        return;
      }

      if (method === "GET" && pathname === "/audit") {
        sendJson(res, 200, { events: options.auditJournal.export() });
        audit("success");
        return;
      }

      if (method === "GET" && pathname === "/metrics") {
        sendJson(res, 200, options.metrics?.snapshot() ?? {});
        audit("success");
        return;
      }

      if (method === "POST" && pathname === "/clients/revoke") {
        const clientId = exactStringBody(await readBoundedJson(req, maxBodyBytes), "clientId", 256);
        if (clientId === undefined) {
          sendJson(res, 400, { error: { code: "invalid_request", message: "Expected clientId" } });
          audit("error");
          return;
        }
        sendJson(res, 200, { revoked: options.oauthService.revokeClientByOwner(clientId) });
        audit("success");
        return;
      }

      if (method === "POST" && pathname === "/tokens/revoke") {
        const token = exactStringBody(await readBoundedJson(req, maxBodyBytes), "token", 1_024);
        if (token === undefined) {
          sendJson(res, 400, { error: { code: "invalid_request", message: "Expected token" } });
          audit("error");
          return;
        }
        sendJson(res, 200, { revoked: options.oauthService.revokeTokenByOwner(token) });
        audit("success");
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: "Route not found" } });
      audit("error");
    })().catch((error: unknown) => {
      options.auditJournal.append({
        timestamp: new Date().toISOString(),
        category: "control",
        capabilityId: "control:request",
        result: "error"
      });
      options.onError?.(error instanceof Error ? error : new Error("Unknown control-plane error"));
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof PayloadTooLargeError
          ? 413
          : error instanceof UnsupportedMediaTypeError
            ? 415
            : error instanceof SyntaxError
              ? 400
              : 500;
      sendJson(res, status, {
        error: {
          code:
            status === 413
              ? "payload_too_large"
              : status === 415
                ? "unsupported_media_type"
                : status === 400
                  ? "invalid_json"
                  : "internal_error",
          message: status === 500 ? "Control-plane request failed" : "Invalid request"
        }
      });
    });
  });
}

export function listenControlPlane(
  server: Server,
  options: ControlListenOptions
): Promise<ControlListenAddress> {
  if (!LOOPBACK_HOSTS.has(options.host)) {
    return Promise.reject(new Error("Control plane must bind to a loopback IP literal"));
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    return Promise.reject(new Error("Control-plane port must be an integer from 0 to 65535"));
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Control plane did not expose a TCP address"));
        return;
      }
      resolve({ host: address.address, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}
