/**
 * OAuth HTTP Router — discovery, DCR, consent, token, and revocation adapter.
 * Wing: auth | Topic: oauth-http-surface | Updated: 2026-08-26
 *
 * Provenance: MCP authorization specification 2026-07-28, RFC 7009,
 * W3C CSP Level 3, ADR-011, ADR-012, and ADR-013.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { readBoundedForm, readBoundedJson } from "../shared/http-body.js";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter.js";
import { type OAuthService } from "./oauth-service.js";

const AUTH_BODY_LIMIT_BYTES = 65_536;
const REGISTRATION_LIMIT_PER_MINUTE = 20;
const AUTHORIZATION_LIMIT_PER_MINUTE = 60;
const TOKEN_LIMIT_PER_MINUTE = 60;
const OWNER_ATTEMPT_LIMIT = 5;
const OWNER_ATTEMPT_WINDOW_SECONDS = 300;
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
} as const;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, {
    "content-length": "0",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end();
}

function sendHtml(res: ServerResponse, status: number, body: string, redirectOrigin: string): void {
  res.writeHead(status, {
    ...HTML_HEADERS,
    "content-security-policy": `default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'`,
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendRateLimit(res: ServerResponse, retryAfterSeconds: number): void {
  res.setHeader("retry-after", String(retryAfterSeconds));
  sendJson(res, 429, {
    error: "too_many_requests",
    error_description: "Too many OAuth requests"
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character] ?? character
  );
}

function uniqueParameters(searchParams: URLSearchParams): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    if (values.length !== 1) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, `Duplicate ${key} parameter`);
    }
    result[key] = values[0];
  }
  return result;
}

function extractBasicClientCredentials(
  req: IncomingMessage
): { clientId: string; clientSecret: string } | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

function errorStatus(error: OAuthError): number {
  if (error.code === OAuthErrorCode.InvalidClient) return 401;
  if (error.code === OAuthErrorCode.TooManyRequests) return 429;
  return 400;
}

function sendOAuthError(res: ServerResponse, error: unknown): void {
  if (error instanceof OAuthError) {
    sendJson(res, errorStatus(error), {
      error: error.code,
      error_description: error.message
    });
    return;
  }
  sendJson(res, 500, { error: "server_error" });
}

function authorizationPage(
  transactionId: string,
  clientName: string,
  scopes: readonly string[],
  authenticationFailed = false
): string {
  const failure = authenticationFailed ? '<p class="error">Owner authentication failed.</p>' : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize SlncTrZ-MCP</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#171717}
main{border:1px solid #d4d4d4;border-radius:.75rem;padding:1.5rem}
label{display:block;margin:1rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.7rem}
.actions{display:flex;gap:.75rem;margin-top:1rem}button{padding:.7rem 1rem}
.error{color:#b91c1c}code{word-break:break-all}
</style>
</head>
<body><main>
<h1>Authorize SlncTrZ-MCP</h1>
<p>Client: <strong>${escapeHtml(clientName)}</strong></p>
<p>Requested scope: <code>${escapeHtml(scopes.join(" "))}</code></p>
${failure}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
<label for="owner_secret">Owner passphrase</label>
<input id="owner_secret" name="owner_secret" type="password" required minlength="16" maxlength="1024">
<div class="actions">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>
</main></body></html>`;
}

export class OAuthHttpRouter {
  readonly #service: OAuthService;
  readonly #registrationLimiter = new FixedWindowRateLimiter({
    limit: REGISTRATION_LIMIT_PER_MINUTE,
    windowSeconds: 60
  });
  readonly #authorizationLimiter = new FixedWindowRateLimiter({
    limit: AUTHORIZATION_LIMIT_PER_MINUTE,
    windowSeconds: 60
  });
  readonly #tokenLimiter = new FixedWindowRateLimiter({
    limit: TOKEN_LIMIT_PER_MINUTE,
    windowSeconds: 60
  });
  readonly #ownerAttemptLimiter = new FixedWindowRateLimiter({
    limit: OWNER_ATTEMPT_LIMIT,
    windowSeconds: OWNER_ATTEMPT_WINDOW_SECONDS
  });

  constructor(service: OAuthService) {
    this.#service = service;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method === "OPTIONS" && this.#isOAuthPath(pathname)) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          "content-type, authorization, mcp-protocol-version, mcp-session-id",
        "cache-control": "no-store"
      });
      res.end();
      return true;
    }

    if (
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource/mcp" ||
        pathname === "/.well-known/oauth-protected-resource")
    ) {
      sendJson(res, 200, this.#service.protectedResourceMetadata());
      return true;
    }

    if (
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-authorization-server" ||
        pathname === "/.well-known/openid-configuration")
    ) {
      sendJson(res, 200, this.#service.authorizationServerMetadata());
      return true;
    }

    if (pathname === "/register") {
      if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");
      const rateLimit = this.#registrationLimiter.consume(this.#peerKey(req));
      if (!rateLimit.allowed) {
        this.#service.recordRateLimit("registration");
        sendRateLimit(res, rateLimit.retryAfterSeconds);
        return true;
      }
      try {
        const input = await readBoundedJson(req, AUTH_BODY_LIMIT_BYTES);
        sendJson(res, 201, this.#service.registerClient(input));
      } catch (error) {
        sendOAuthError(res, error);
      }
      return true;
    }

    if (pathname === "/authorize") {
      if (req.method === "GET") {
        const rateLimit = this.#authorizationLimiter.consume(this.#peerKey(req));
        if (!rateLimit.allowed) {
          this.#service.recordRateLimit("authorization");
          sendRateLimit(res, rateLimit.retryAfterSeconds);
          return true;
        }
        try {
          const pending = this.#service.beginAuthorization(uniqueParameters(url.searchParams));
          sendHtml(
            res,
            200,
            authorizationPage(pending.transactionId, pending.clientName, pending.scopes),
            pending.redirectOrigin
          );
        } catch (error) {
          sendOAuthError(res, error);
        }
        return true;
      }

      if (req.method === "POST") {
        let transactionId = "";
        try {
          const form = await readBoundedForm(req, AUTH_BODY_LIMIT_BYTES);
          transactionId = form.get("transaction_id") ?? "";
          if (form.get("decision") === "deny") {
            this.#redirect(res, this.#service.denyAuthorization(transactionId));
            return true;
          }
          const rateLimit = this.#ownerAttemptLimiter.consume(this.#peerKey(req));
          if (!rateLimit.allowed) {
            this.#service.recordRateLimit("owner_authentication");
            sendRateLimit(res, rateLimit.retryAfterSeconds);
            return true;
          }
          const ownerSecret = form.get("owner_secret") ?? "";
          this.#redirect(res, this.#service.approveAuthorization(transactionId, ownerSecret));
        } catch (error) {
          if (error instanceof OAuthError && error.code === OAuthErrorCode.AccessDenied) {
            const pending = this.#service.authorizationDetails(transactionId);
            sendHtml(
              res,
              401,
              authorizationPage(pending.transactionId, pending.clientName, pending.scopes, true),
              pending.redirectOrigin
            );
          } else {
            sendOAuthError(res, error);
          }
        }
        return true;
      }

      return this.#methodNotAllowed(res, "GET, POST");
    }

    if (pathname === "/token") {
      if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");
      const rateLimit = this.#tokenLimiter.consume(this.#peerKey(req));
      if (!rateLimit.allowed) {
        this.#service.recordRateLimit("token");
        sendRateLimit(res, rateLimit.retryAfterSeconds);
        return true;
      }
      try {
        const form = await readBoundedForm(req, AUTH_BODY_LIMIT_BYTES);
        const parameters = uniqueParameters(form);
        this.#applyBasicClientCredentials(req, parameters);
        const response =
          parameters.grant_type === "refresh_token"
            ? this.#service.exchangeRefreshToken(parameters)
            : this.#service.exchangeAuthorizationCode(parameters);
        sendJson(res, 200, response);
      } catch (error) {
        sendOAuthError(res, error);
      }
      return true;
    }

    if (pathname === "/revoke") {
      if (req.method !== "POST") return this.#methodNotAllowed(res, "POST");
      const rateLimit = this.#tokenLimiter.consume(this.#peerKey(req));
      if (!rateLimit.allowed) {
        this.#service.recordRateLimit("token");
        sendRateLimit(res, rateLimit.retryAfterSeconds);
        return true;
      }
      try {
        const form = await readBoundedForm(req, AUTH_BODY_LIMIT_BYTES);
        const parameters = uniqueParameters(form);
        this.#applyBasicClientCredentials(req, parameters);
        this.#service.revokeToken(parameters);
        sendEmpty(res, 200);
      } catch (error) {
        sendOAuthError(res, error);
      }
      return true;
    }

    return false;
  }

  #isOAuthPath(pathname: string): boolean {
    return (
      pathname.startsWith("/.well-known/") ||
      pathname === "/register" ||
      pathname === "/authorize" ||
      pathname === "/token" ||
      pathname === "/revoke"
    );
  }

  #applyBasicClientCredentials(
    req: IncomingMessage,
    parameters: Record<string, string | undefined>
  ): void {
    const basic = extractBasicClientCredentials(req);
    if (basic !== undefined) {
      parameters.client_id = basic.clientId;
      parameters.client_secret = basic.clientSecret;
    }
  }

  #peerKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  #methodNotAllowed(res: ServerResponse, allow: string): true {
    res.setHeader("allow", allow);
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  #redirect(res: ServerResponse, location: URL): void {
    res.writeHead(303, {
      location: location.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    });
    res.end();
  }
}
