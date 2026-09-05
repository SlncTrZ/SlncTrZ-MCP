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
    "content-security-policy": `default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'`,
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
  const failure = authenticationFailed
    ? '<p class="error" role="alert">Owner authentication failed. Please verify your passphrase and try again.</p>'
    : "";
  const scopeItems = scopes.length
    ? scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")
    : "<li>No additional access requested.</li>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize application &middot; SlncTrZ-MCP</title>
<style>
:root{color-scheme:light dark}
@font-face{font-family:"SlncHertine";src:url(/assets/fonts/SlncHertine.woff2) format("woff2");font-display:swap;font-weight:400;font-style:normal}
@property --angle{syntax:"<angle>";initial-value:0deg;inherits:false}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2rem;padding:2rem 1rem;background:#eef0f3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;-webkit-font-smoothing:antialiased;line-height:1.5}
.brandmark{font-family:"SlncHertine","Segoe UI",system-ui,sans-serif;font-size:2.1rem;font-weight:600;letter-spacing:.02em;color:#1a1d21;text-align:center;background:linear-gradient(45deg,#22d3ee 0%,#a855f7 50%,#22d3ee 100%);background-size:200% 200%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 0 6px rgba(34,211,238,.30)) drop-shadow(0 0 8px rgba(168,85,247,.30));animation:wordmark-flow 3s linear infinite}
@keyframes wordmark-flow{0%{background-position:0% 50%}100%{background-position:200% 50%}}
.neon-frame{position:relative;width:100%;max-width:26rem;padding:2px;border-radius:14px;background:conic-gradient(from var(--angle),#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg);animation:neon-spin 1.33s linear infinite;box-shadow:0 0 16px rgba(168,85,247,.30),0 0 16px rgba(34,211,238,.22),0 1px 2px rgba(16,24,40,.06);filter:drop-shadow(0 0 5px rgba(168,85,247,.4))}
@keyframes neon-spin{to{--angle:360deg}}
.card{width:100%;background:linear-gradient(180deg,#fbfcfd 0%,#e9edf3 100%);border:none;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 28px rgba(16,24,40,.07);padding:1.75rem}
.brand{display:flex;align-items:center;gap:.5rem;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#697586;margin:0 0 1.1rem}
.brand .dot{width:.5rem;height:.5rem;border-radius:50%;background:#2f5a9e}
h1{font-size:1.3rem;font-weight:650;line-height:1.25;margin:0 0 .5rem}
p.lead{margin:0 0 1.1rem;color:#475467;font-size:.92rem}
p.lead strong{color:#1a1d21;font-weight:600;word-break:break-word}
.scope{margin:0 0 1.25rem;padding:.85rem 1rem;background:#f8fafc;border:1px solid #eaedf1;border-radius:10px}
.scope h2{margin:0 0 .5rem;font-size:.7rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#697586}
.scope ul{margin:0;padding-left:1.1rem;color:#344054;font-size:.84rem;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word}
.error{margin:0 0 1rem;padding:.7rem .85rem;background:#fef3f2;border:1px solid #fda29b;border-radius:10px;color:#b42318;font-size:.86rem}
label{display:block;font-size:.85rem;font-weight:600;color:#1a1d21;margin:0 0 .4rem}
input[type=password]{width:100%;padding:.7rem .8rem;font-size:.95rem;color:#1a1d21;background:#fff;border:1px solid #d0d5dd;border-radius:9px;font-family:inherit}
input[type=password]:focus{outline:none;border-color:#2f5a9e;box-shadow:0 0 0 3px rgba(47,90,158,.18)}
.hint{margin:.5rem 0 1.25rem;font-size:.78rem;color:#697586;line-height:1.45}
.actions{display:flex;gap:.6rem;margin-top:.25rem}
button{flex:1;padding:.7rem .9rem;font-size:.92rem;font-weight:600;border-radius:9px;cursor:pointer;font-family:inherit;border:1px solid transparent;transition:background-color .15s ease,transform .05s ease}
button:active{transform:translateY(1px)}
.btn-approve{background:#2f5a9e;color:#fff}
.btn-approve:hover{background:#274d88}
.btn-approve:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(47,90,158,.4)}
.btn-deny{background:#fff;color:#475467;border-color:#d0d5dd}
.btn-deny:hover{background:#f8fafc;color:#1a1d21}
.btn-deny:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(16,24,40,.12)}
.foot{margin:1.25rem 0 0;padding-top:.9rem;border-top:1px solid #eaedf1;font-size:.76rem;color:#697586;line-height:1.45}
.signature{font-family:"SlncHertine","Segoe UI",system-ui,sans-serif;font-size:.82rem;font-weight:500;letter-spacing:.04em;text-align:right;margin:.7rem 0 0;color:#8b94a3}
@media (prefers-color-scheme:dark){
body{background:#0f1115;color:#e6e8eb}
.brandmark{color:#e6e8eb}
.card{background:linear-gradient(180deg,#1a1e25 0%,#13161c 100%);border-color:#262b33;box-shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px rgba(0,0,0,.5)}
.brand{color:#9aa4b2}.brand .dot{background:#5b8def}
p.lead{color:#9aa4b2}p.lead strong{color:#e6e8eb}
.scope{background:#1b1f26;border-color:#262b33}.scope h2{color:#9aa4b2}.scope ul{color:#c2c8d0}
.error{background:#2a1416;border-color:#7a2e2e;color:#f29b9b}
label{color:#e6e8eb}
input[type=password]{background:#0f1115;color:#e6e8eb;border-color:#333a44}
input[type=password]:focus{border-color:#5b8def;box-shadow:0 0 0 3px rgba(91,141,239,.25)}
.btn-approve{background:#3b6fd4}.btn-approve:hover{background:#3461bd}.btn-approve:focus-visible{box-shadow:0 0 0 3px rgba(91,141,239,.45)}
.btn-deny{background:#1b1f26;color:#c2c8d0;border-color:#333a44}.btn-deny:hover{background:#22272f;color:#e6e8eb}
.foot{color:#9aa4b2;border-top-color:#262b33}.hint{color:#9aa4b2}
.signature{color:#6b7480}
}
@media (prefers-reduced-motion:reduce){button{transition:none}.brandmark{animation:none}.neon-frame{animation:none;background:conic-gradient(from 0deg,#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg)}}
@media (max-width:480px){body{justify-content:flex-start;gap:1rem;padding:1rem .9rem}.brandmark{font-size:1.7rem}.actions{flex-direction:column}}
</style>
</head>
<body><div class="brandmark">&nbsp;&nbsp;&nbsp;&nbsp;SlncTrZ&nbsp;&nbsp;&nbsp;&nbsp;</div><div class="neon-frame"><main class="card">
<div class="brand"><span class="dot" aria-hidden="true"></span>SlncTrZ-MCP &middot; Authorization</div>
<h1>Authorize this application</h1>
<p class="lead"><strong>${escapeHtml(clientName)}</strong> is requesting access to your SlncTrZ-MCP server.</p>
<div class="scope"><h2>Requested access</h2><ul>${scopeItems}</ul></div>
${failure}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
<label for="owner_secret">Owner passphrase</label>
<input id="owner_secret" name="owner_secret" type="password" required minlength="16" maxlength="1024" autocomplete="off">
<p class="hint">Set when the server was configured. Must be at least 16 characters.</p>
<div class="actions">
<button type="submit" class="btn-approve" name="decision" value="approve">Approve</button>
<button type="submit" class="btn-deny" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>
<p class="foot">Only approve if you initiated this request. Denying stops the application from connecting.</p>
<p class="signature">SlncTrZ-MCP</p>
</main></div></body></html>`;
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
