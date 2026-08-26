/**
 * OAuth Service — OAuth 2.1 authorization-code, PKCE, DCR, and opaque tokens.
 * Wing: auth | Topic: oauth-authorization-server | Updated: 2026-08-26
 *
 * Provenance: MCP authorization specification 2026-07-28, RFC 7009, RFC 7591,
 * RFC 7636, RFC 8707, RFC 9207, RFC 9728, SECURITY invariant 1, and ADR-012.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";
import { type AuthAuditSink } from "../observability/auth-audit.js";
import { validateOwnerSecretHash, verifyOwnerSecret } from "./owner-verifier.js";

const DEFAULT_SCOPE = "mcp:tools";
const AUTHORIZATION_CODE_TTL_SECONDS = 300;
const PENDING_AUTHORIZATION_TTL_SECONDS = 600;
const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REDIRECT_URIS = 10;

type StringRecord = Record<string, string | undefined>;

interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly issuedAt: number;
}

interface PendingAuthorization {
  readonly transactionId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly expiresAt: number;
}

interface AuthorizationCodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

interface TokenRecord {
  readonly token: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface OAuthServiceOptions {
  readonly issuer: URL;
  readonly resource: URL;
  readonly ownerSecretHash: string;
  readonly audit?: AuthAuditSink;
  /** Optional pre-registered confidential client for static-credential flows. */
  readonly staticClient?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly clientName?: string;
    readonly redirectUris: readonly string[];
  };
  readonly now?: () => number;
}

export interface RegisteredClientResponse {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly client_name?: string;
  readonly redirect_uris: readonly string[];
  readonly grant_types: readonly ["authorization_code", "refresh_token"];
  readonly response_types: readonly ["code"];
  readonly token_endpoint_auth_method: "none";
  readonly client_secret?: undefined;
}

export interface PendingAuthorizationResponse {
  readonly transactionId: string;
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
  readonly resource: string;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthError(OAuthErrorCode.InvalidRequest, message);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuthError(OAuthErrorCode.InvalidRequest, `${name} is required`);
  }
  return value;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, `${name} must be a string array`);
  }
  return value as string[];
}

function randomIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function normalizeIssuer(issuer: URL): URL {
  const normalized = safeUrl(issuer, "Invalid issuer");
  normalized.hash = "";
  normalized.search = "";
  if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
  return normalized;
}

function validateHttpsUrl(url: URL, field: string): void {
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${field} must be an HTTPS URL without credentials or fragment`);
  }
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, "Invalid redirect URI");
  }

  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost");
  const secure = url.protocol === "https:";

  if (
    (!secure && !loopback) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new OAuthError(
      OAuthErrorCode.InvalidRedirectUri,
      "redirect URI must use HTTPS or an HTTP loopback address"
    );
  }

  return url.href;
}

function safeUrl(value: string | URL, message: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidRequest, message);
  }
}

function exactResource(requested: string, configured: URL): string {
  let parsed: URL;
  try {
    parsed = new URL(requested);
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidTarget, "Invalid resource");
  }
  parsed.hash = "";
  if (parsed.href !== configured.href) {
    throw new OAuthError(OAuthErrorCode.InvalidTarget, "Resource does not match this MCP server");
  }
  return parsed.href;
}

/** In-process OAuth authority. Restart invalidates all issued clients and tokens. */
export class OAuthService implements OAuthTokenVerifier {
  readonly #issuer: URL;
  readonly #resource: URL;
  readonly #ownerSecretHash: string;
  readonly #now: () => number;
  readonly #audit: AuthAuditSink;
  readonly #clients = new Map<string, RegisteredClient>();
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #accessTokens = new Map<string, TokenRecord>();
  readonly #refreshTokens = new Map<string, TokenRecord>();

  constructor(options: OAuthServiceOptions) {
    this.#issuer = normalizeIssuer(options.issuer);
    this.#resource = safeUrl(options.resource, "Invalid resource");
    this.#resource.hash = "";
    validateHttpsUrl(this.#issuer, "issuer");
    validateHttpsUrl(this.#resource, "resource");
    if (this.#resource.origin !== this.#issuer.origin) {
      throw new Error("OAuth issuer and MCP resource must share an origin");
    }
    validateOwnerSecretHash(options.ownerSecretHash);
    this.#ownerSecretHash = options.ownerSecretHash;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#audit = options.audit ?? (() => undefined);
    if (options.staticClient !== undefined) {
      const { clientId, clientSecret, clientName, redirectUris } = options.staticClient;
      this.#clients.set(clientId, {
        clientId,
        clientSecret,
        ...(clientName === undefined ? {} : { clientName }),
        redirectUris: [...new Set(redirectUris.map(validateRedirectUri))],
        issuedAt: this.#now()
      });
    }
  }

  get issuer(): URL {
    return safeUrl(this.#issuer, "Invalid issuer");
  }

  get resource(): URL {
    return safeUrl(this.#resource, "Invalid resource");
  }

  get resourceMetadataUrl(): string {
    const url = new URL("/.well-known/oauth-protected-resource", this.#issuer);
    url.pathname += this.#resource.pathname;
    return url.href;
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.#issuer.href,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: new URL("authorize", this.#issuer).href,
      token_endpoint: new URL("token", this.#issuer).href,
      registration_endpoint: new URL("register", this.#issuer).href,
      revocation_endpoint: new URL("revoke", this.#issuer).href,
      revocation_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none"
      ],
      scopes_supported: [DEFAULT_SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"]
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.#resource.href,
      authorization_servers: [this.#issuer.href],
      scopes_supported: [DEFAULT_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "SlncTrZ-MCP"
    };
  }

  registerClient(input: unknown): RegisteredClientResponse {
    const metadata = requireObject(input, "Client metadata must be an object");
    const redirectUris = optionalStringArray(metadata.redirect_uris, "redirect_uris");
    if (
      redirectUris === undefined ||
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REDIRECT_URIS
    ) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        `redirect_uris must contain 1-${MAX_REDIRECT_URIS} entries`
      );
    }

    const grantTypes = optionalStringArray(metadata.grant_types, "grant_types") ?? [
      "authorization_code"
    ];
    if (
      grantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token") ||
      !grantTypes.includes("authorization_code")
    ) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Only authorization_code and refresh_token grants are supported"
      );
    }

    const responseTypes = optionalStringArray(metadata.response_types, "response_types") ?? [
      "code"
    ];
    if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Only code responses are supported"
      );
    }

    const authMethod = optionalString(metadata.token_endpoint_auth_method) ?? "none";
    if (authMethod !== "none") {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Only public clients using token_endpoint_auth_method=none are supported"
      );
    }

    const normalizedRedirects = [...new Set(redirectUris.map(validateRedirectUri))];
    const clientId = randomIdentifier("client");
    const issuedAt = this.#now();
    const clientName = optionalString(metadata.client_name)?.slice(0, 128);
    const client: RegisteredClient = {
      clientId,
      redirectUris: normalizedRedirects,
      issuedAt,
      ...(clientName === undefined ? {} : { clientName })
    };
    this.#clients.set(clientId, client);
    this.#emit("client.registered", "success", clientId);

    return {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: normalizedRedirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(clientName === undefined ? {} : { client_name: clientName })
    };
  }

  pkceChallenge(verifier: string): string {
    if (!PKCE_VERIFIER_PATTERN.test(verifier)) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid PKCE code_verifier");
    }
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
  }

  beginAuthorization(parameters: StringRecord): PendingAuthorizationResponse {
    this.#purgeExpired();
    if (parameters.response_type !== "code") {
      throw new OAuthError(OAuthErrorCode.UnsupportedResponseType, "response_type must be code");
    }

    const clientId = requiredString(parameters.client_id, "client_id");
    const client = this.#clients.get(clientId);
    if (client === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidClient, "Unknown client");
    }

    const redirectUri = validateRedirectUri(
      requiredString(parameters.redirect_uri, "redirect_uri")
    );
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "redirect_uri is not registered");
    }

    if (parameters.code_challenge_method !== "S256") {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "PKCE S256 is required");
    }
    const codeChallenge = requiredString(parameters.code_challenge, "code_challenge");
    if (!PKCE_CHALLENGE_PATTERN.test(codeChallenge)) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "Invalid PKCE code_challenge");
    }

    const resource = exactResource(requiredString(parameters.resource, "resource"), this.#resource);
    const scopes = this.#parseScopes(parameters.scope);
    const transactionId = randomIdentifier("auth");
    const expiresAt = this.#now() + PENDING_AUTHORIZATION_TTL_SECONDS;
    const pending: PendingAuthorization = {
      transactionId,
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scopes,
      expiresAt,
      ...(parameters.state === undefined ? {} : { state: parameters.state })
    };
    this.#pending.set(transactionId, pending);

    return {
      transactionId,
      clientName: client.clientName ?? "MCP client",
      redirectOrigin: safeUrl(redirectUri, "Invalid redirect URI").origin,
      scopes,
      expiresAt
    };
  }

  authorizationDetails(transactionId: string): PendingAuthorizationResponse {
    this.#purgeExpired();
    const pending = this.#pending.get(transactionId);
    if (pending === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization transaction is invalid");
    }
    const client = this.#clients.get(pending.clientId);
    return {
      transactionId,
      clientName: client?.clientName ?? "MCP client",
      redirectOrigin: safeUrl(pending.redirectUri, "Invalid redirect URI").origin,
      scopes: [...pending.scopes],
      expiresAt: pending.expiresAt
    };
  }

  approveAuthorization(transactionId: string, ownerSecret: string): URL {
    this.#purgeExpired();
    const pending = this.#pending.get(transactionId);
    if (pending === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization transaction is invalid");
    }
    if (!verifyOwnerSecret(ownerSecret, this.#ownerSecretHash)) {
      this.#emit("authorization.failed", "failure", pending.clientId, "invalid_owner");
      throw new OAuthError(OAuthErrorCode.AccessDenied, "Owner authentication failed");
    }

    this.#pending.delete(transactionId);
    this.#emit("authorization.approved", "success", pending.clientId);
    const code = randomIdentifier("code");
    this.#codes.set(code, {
      code,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scopes: pending.scopes,
      expiresAt: this.#now() + AUTHORIZATION_CODE_TTL_SECONDS
    });

    const redirect = safeUrl(pending.redirectUri, "Invalid redirect URI");
    redirect.searchParams.set("code", code);
    if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.#issuer.href);
    return redirect;
  }

  denyAuthorization(transactionId: string): URL {
    this.#purgeExpired();
    const pending = this.#pending.get(transactionId);
    if (pending === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization transaction is invalid");
    }
    this.#pending.delete(transactionId);
    this.#emit("authorization.denied", "success", pending.clientId);
    const redirect = safeUrl(pending.redirectUri, "Invalid redirect URI");
    redirect.searchParams.set("error", "access_denied");
    if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.#issuer.href);
    return redirect;
  }

  exchangeAuthorizationCode(parameters: StringRecord): OAuthTokenResponse {
    this.#purgeExpired();
    if (parameters.grant_type !== "authorization_code") {
      throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Unsupported grant_type");
    }

    const code = requiredString(parameters.code, "code");
    const record = this.#codes.get(code);
    if (record === undefined) throw new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid code");

    const clientId = requiredString(parameters.client_id, "client_id");
    this.#verifyClientSecret(clientId, parameters.client_secret);
    const redirectUri = validateRedirectUri(
      requiredString(parameters.redirect_uri, "redirect_uri")
    );
    const resource = exactResource(requiredString(parameters.resource, "resource"), this.#resource);
    const verifier = requiredString(parameters.code_verifier, "code_verifier");

    if (
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.resource !== resource ||
      this.pkceChallenge(verifier) !== record.codeChallenge
    ) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code binding failed");
    }

    this.#codes.delete(code);
    return this.#issueTokens(record.clientId, record.resource, record.scopes, "token.issued");
  }

  exchangeRefreshToken(parameters: StringRecord): OAuthTokenResponse {
    this.#purgeExpired();
    if (parameters.grant_type !== "refresh_token") {
      throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Unsupported grant_type");
    }

    const token = requiredString(parameters.refresh_token, "refresh_token");
    const record = this.#refreshTokens.get(token);
    if (record === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid refresh token");
    }

    const clientId = requiredString(parameters.client_id, "client_id");
    this.#verifyClientSecret(clientId, parameters.client_secret);
    const resource = exactResource(requiredString(parameters.resource, "resource"), this.#resource);
    if (record.clientId !== clientId || record.resource !== resource) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token binding failed");
    }

    this.#refreshTokens.delete(token);
    return this.#issueTokens(
      record.clientId,
      record.resource,
      record.scopes,
      "token.refreshed",
      record.grantId
    );
  }

  revokeToken(parameters: StringRecord): void {
    this.#purgeExpired();
    const token = requiredString(parameters.token, "token");
    const clientId = requiredString(parameters.client_id, "client_id");
    this.#verifyClientSecret(clientId, parameters.client_secret);

    const hinted =
      parameters.token_type_hint === "access_token"
        ? this.#accessTokens.get(token)
        : parameters.token_type_hint === "refresh_token"
          ? this.#refreshTokens.get(token)
          : undefined;
    const record = hinted ?? this.#accessTokens.get(token) ?? this.#refreshTokens.get(token);
    if (record === undefined) {
      this.#emit("token.revoked", "ignored", clientId, "invalid_token");
      return;
    }
    if (record.clientId !== clientId) {
      this.#emit("token.revoked", "ignored", clientId, "client_mismatch");
      return;
    }

    for (const [key, value] of this.#accessTokens) {
      if (value.grantId === record.grantId) this.#accessTokens.delete(key);
    }
    for (const [key, value] of this.#refreshTokens) {
      if (value.grantId === record.grantId) this.#refreshTokens.delete(key);
    }
    this.#emit("token.revoked", "success", clientId);
  }

  recordRateLimit(operation: "registration" | "token" | "owner_authentication"): void {
    this.#emit("rate_limit.triggered", "failure", undefined, undefined, operation);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.#purgeExpired();
    const record = this.#accessTokens.get(token);
    if (record === undefined) {
      this.#emit("token.rejected", "failure", undefined, "invalid_token");
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
    }

    return {
      token: record.token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      resource: safeUrl(record.resource, "Invalid resource")
    };
  }

  #verifyClientSecret(clientId: string, clientSecret: string | undefined): void {
    const client = this.#clients.get(clientId);
    if (client === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidClient, "Unknown client");
    }
    if (client.clientSecret !== undefined) {
      if (clientSecret === undefined || clientSecret.length === 0) {
        throw new OAuthError(OAuthErrorCode.InvalidClient, "client_secret is required");
      }
      const expected = Buffer.from(client.clientSecret, "utf8");
      const provided = Buffer.from(clientSecret, "utf8");
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new OAuthError(OAuthErrorCode.InvalidClient, "client authentication failed");
      }
    }
  }

  #parseScopes(rawScope: string | undefined): string[] {
    const scopes = rawScope?.split(/\s+/u).filter(Boolean) ?? [DEFAULT_SCOPE];
    if (scopes.length === 0 || scopes.some((scope) => scope !== DEFAULT_SCOPE)) {
      throw new OAuthError(OAuthErrorCode.InvalidScope, "Unsupported scope");
    }
    return [...new Set(scopes)];
  }

  #issueTokens(
    clientId: string,
    resource: string,
    scopes: readonly string[],
    auditType: "token.issued" | "token.refreshed",
    existingGrantId?: string
  ): OAuthTokenResponse {
    const now = this.#now();
    const accessToken = randomIdentifier("at");
    const refreshToken = randomIdentifier("rt");
    const grantId = existingGrantId ?? randomIdentifier("grant");
    this.#accessTokens.set(accessToken, {
      token: accessToken,
      grantId,
      clientId,
      resource,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS
    });
    this.#refreshTokens.set(refreshToken, {
      token: refreshToken,
      grantId,
      clientId,
      resource,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS
    });
    this.#emit(auditType, "success", clientId);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      resource
    };
  }

  #emit(
    type: Parameters<AuthAuditSink>[0]["type"],
    outcome: Parameters<AuthAuditSink>[0]["outcome"],
    clientId?: string,
    reason?: Parameters<AuthAuditSink>[0]["reason"],
    operation?: Parameters<AuthAuditSink>[0]["operation"]
  ): void {
    this.#audit({
      timestamp: new Date(this.#now() * 1_000).toISOString(),
      type,
      outcome,
      ...(clientId === undefined ? {} : { clientId }),
      ...(reason === undefined ? {} : { reason }),
      ...(operation === undefined ? {} : { operation })
    });
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [key, value] of this.#pending) {
      if (value.expiresAt <= now) this.#pending.delete(key);
    }
    for (const [key, value] of this.#codes) {
      if (value.expiresAt <= now) this.#codes.delete(key);
    }
    for (const [key, value] of this.#accessTokens) {
      if (value.expiresAt <= now) this.#accessTokens.delete(key);
    }
    for (const [key, value] of this.#refreshTokens) {
      if (value.expiresAt <= now) this.#refreshTokens.delete(key);
    }
  }
}
