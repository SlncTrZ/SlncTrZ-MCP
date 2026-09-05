/** Loopback-only local diagnostics and revocation control plane. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

function authorized(req: IncomingMessage, ownerSecretHash: string): boolean {
  const secret = bearer(req);
  return secret !== undefined && verifyOwnerSecret(secret, ownerSecretHash);
}

export function createControlPlaneServer(options: ControlPlaneOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CONTROL_BODY_BYTES;
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

      if (!authorized(req, options.ownerSecretHash)) {
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
