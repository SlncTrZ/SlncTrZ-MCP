/**
 * Loopback-only local control plane.
 *
 * This server is a distinct listener from the public MCP data plane. Every route requires the
 * owner verifier, bodies are bounded, responses are no-store, and errors never echo credentials.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
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
  readonly oauthService: Pick<
    OAuthService,
    "recordRateLimit" | "revokeClientByOwner" | "revokeTokenByOwner"
  >;
  readonly policyStore: Pick<PolicySnapshotStore, "capture" | "reload">;
  readonly auditJournal: AuditJournal;
  readonly metrics?: MetricsRegistry;
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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function bearerSecret(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined || Array.isArray(header) || !header.startsWith("Bearer ")) {
    return undefined;
  }
  const secret = header.slice("Bearer ".length);
  return secret.length > 0 ? secret : undefined;
}

function recordControl(
  journal: AuditJournal,
  requestId: string,
  capabilityId: string,
  result: "success" | "error" | "denied",
  startedAt: number,
  clientId?: string
): void {
  journal.append({
    timestamp: new Date().toISOString(),
    category: "control",
    requestId,
    capabilityId,
    result,
    durationMs: Math.max(0, performance.now() - startedAt),
    ...(clientId === undefined ? {} : { clientId })
  });
}

function objectBody(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function exactStringBody(value: unknown, key: string, maxLength: number): string | undefined {
  const body = objectBody(value);
  if (body === undefined || Object.keys(body).length !== 1) return undefined;
  const field = body[key];
  return typeof field === "string" && field.length > 0 && field.length <= maxLength
    ? field
    : undefined;
}

export function createControlPlaneServer(options: ControlPlaneOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CONTROL_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("Control-plane body limit must be a positive safe integer");
  }
  const authLimiter = new FixedWindowRateLimiter({ limit: 20, windowSeconds: 60 });

  return createServer((req, res) => {
    void (async () => {
      const requestId = randomUUID();
      const startedAt = performance.now();
      const secret = bearerSecret(req);
      if (secret === undefined || !verifyOwnerSecret(secret, options.ownerSecretHash)) {
        const peer = req.socket.remoteAddress ?? "unknown";
        const rate = authLimiter.consume(peer);
        recordControl(options.auditJournal, requestId, "control.authenticate", "denied", startedAt);
        if (!rate.allowed) {
          options.oauthService.recordRateLimit("owner_authentication");
          res.setHeader("retry-after", String(rate.retryAfterSeconds));
          sendJson(res, 429, { error: { code: "rate_limited", message: "Rate limit exceeded" } });
          return;
        }
        sendJson(res, 401, {
          error: { code: "unauthorized", message: "Owner authentication required" }
        });
        return;
      }

      const method = req.method ?? "GET";
      const pathname = new URL(req.url ?? "/", "http://control.local").pathname;

      if (method === "GET" && pathname === "/status") {
        const snapshot = options.policyStore.capture();
        sendJson(res, 200, {
          policyVersion: snapshot.version,
          workspaceCount: snapshot.normalized.workspaces.length,
          bindingCount: snapshot.normalized.clientBindings.length,
          extensions: snapshot.extensionStatus?.() ?? []
        });
        recordControl(options.auditJournal, requestId, "control.status", "success", startedAt);
        return;
      }

      if (method === "GET" && pathname === "/policy") {
        const snapshot = options.policyStore.capture();
        sendJson(res, 200, {
          policyVersion: snapshot.version,
          workspaces: snapshot.normalized.workspaces.map((workspace) => ({
            id: workspace.id,
            profiles: workspace.profiles,
            capabilities: workspace.kernelPolicy.capabilities,
            extensionGrants: workspace.extensionGrants.map((grant) => ({
              providerId: grant.providerId,
              toolIds: grant.toolIds,
              profiles: grant.profiles
            }))
          }))
        });
        recordControl(options.auditJournal, requestId, "control.policy.view", "success", startedAt);
        return;
      }

      if (method === "GET" && pathname === "/metrics") {
        if (options.metrics === undefined) {
          sendJson(res, 404, {
            error: { code: "telemetry_disabled", message: "Telemetry is disabled" }
          });
          recordControl(options.auditJournal, requestId, "control.metrics", "error", startedAt);
          return;
        }
        sendJson(res, 200, options.metrics.snapshot());
        recordControl(options.auditJournal, requestId, "control.metrics", "success", startedAt);
        return;
      }

      if (method === "GET" && pathname === "/audit") {
        const url = new URL(req.url ?? "/", "http://control.local");
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        try {
          sendJson(res, 200, { events: options.auditJournal.export({ limit }) });
          recordControl(options.auditJournal, requestId, "control.audit", "success", startedAt);
        } catch {
          sendJson(res, 400, {
            error: { code: "invalid_limit", message: "Audit limit must be a non-negative integer" }
          });
          recordControl(options.auditJournal, requestId, "control.audit", "error", startedAt);
        }
        return;
      }

      if (method === "POST" && pathname === "/policy/reload") {
        const result = await options.policyStore.reload({ ownerApproved: true });
        sendJson(res, result.activated ? 200 : 409, result);
        recordControl(
          options.auditJournal,
          requestId,
          "control.policy.reload",
          result.activated ? "success" : "error",
          startedAt
        );
        return;
      }

      if (method === "POST" && pathname === "/clients/revoke") {
        const clientId = exactStringBody(await readBoundedJson(req, maxBodyBytes), "clientId", 256);
        if (clientId === undefined) {
          sendJson(res, 400, {
            error: { code: "invalid_request", message: "Expected one bounded clientId" }
          });
          recordControl(
            options.auditJournal,
            requestId,
            "control.client.revoke",
            "error",
            startedAt
          );
          return;
        }
        const revoked = options.oauthService.revokeClientByOwner(clientId);
        sendJson(res, 200, { revoked });
        recordControl(
          options.auditJournal,
          requestId,
          "control.client.revoke",
          "success",
          startedAt,
          clientId
        );
        return;
      }

      if (method === "POST" && pathname === "/tokens/revoke") {
        const token = exactStringBody(await readBoundedJson(req, maxBodyBytes), "token", 1_024);
        if (token === undefined) {
          sendJson(res, 400, {
            error: { code: "invalid_request", message: "Expected one bounded token" }
          });
          recordControl(
            options.auditJournal,
            requestId,
            "control.token.revoke",
            "error",
            startedAt
          );
          return;
        }
        const revoked = options.oauthService.revokeTokenByOwner(token);
        sendJson(res, 200, { revoked });
        recordControl(
          options.auditJournal,
          requestId,
          "control.token.revoke",
          "success",
          startedAt
        );
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: "Route not found" } });
    })().catch((error: unknown) => {
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
