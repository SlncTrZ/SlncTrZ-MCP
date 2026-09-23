/**
 * OAuth Service — OAuth 2.1 authorization-code, PKCE, DCR, and opaque tokens.
 * Wing: auth | Topic: oauth-authorization-server | Updated: 2026-08-26
 *
 * Provenance: MCP authorization specification 2026-07-28, RFC 7009, RFC 7591,
 * RFC 7636, RFC 8707, RFC 9207, RFC 9728, SECURITY invariant 1,
 * ADR-012, and ADR-013.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from "@modelcontextprotocol/server";
import { type AuthAuditReason, type AuthAuditSink } from "../observability/auth-audit.js";
import { validateOwnerSecretHash, verifyOwnerSecret } from "./owner-verifier.js";
import {
  createSqliteOAuthGrantStore,
  type OAuthGrantStore,
  type VerifiedGrantToken
} from "./oauth-grant-store.js";
import { type AuthenticatedConnection, type SurfaceProfile } from "./connection-profile.js";

const DEFAULT_SCOPE = "mcp:tools";
const AUTHORIZATION_CODE_TTL_SECONDS = 300;
const PENDING_AUTHORIZATION_TTL_SECONDS = 600;
const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REDIRECT_URIS = 10;
const DEFAULT_MAX_DYNAMIC_CLIENTS = 1_024;

type StringRecord = Record<string, string | undefined>;

interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly issuedAt: number;
}

interface PendingRedirectRegistration {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly provider: "gemini";
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
  readonly pendingRedirectRegistration?: PendingRedirectRegistration;
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

export interface OAuthServiceOptions {
  /** Caller-owned durable grant store. Omission keeps an isolated ephemeral compatibility store. */
  readonly grantStore?: OAuthGrantStore;
  readonly issuer: URL;
  readonly resource: URL;
  readonly ownerSecretHash: string;
  readonly audit?: AuthAuditSink;
  readonly maxDynamicClients?: number;
  /** Durable store for dynamic public-client registrations (survives restart). */
  readonly dynamicClientStore?: {
    readonly load: () => readonly DynamicClientRecord[];
    readonly save: (clients: readonly DynamicClientRecord[]) => void;
  };
  /** Durable owner-approved redirect registrations for the configured static client. */
  readonly staticRedirectStore?: {
    readonly add: (clientId: string, redirectUri: string, updatedAt: number) => readonly string[];
  };
  /** Optional pre-registered confidential client for static-credential flows. */
  readonly staticClient?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly clientName?: string;
    readonly redirectUris: readonly string[];
  };
  /** Hooked after an owner approves a client; used to auto-bind the client into a workspace. */
  readonly onAuthorizationApproved?: (clientId: string) => Promise<void>;
  /** Hooked whenever a token is issued; used to auto-bind an authenticated client into default. */
  readonly onAuthorized?: (clientId: string) => Promise<void>;
  readonly now?: () => number;
}

/** Serializable dynamic-client registration (public client; no secret). */
export interface DynamicClientRecord {
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly issuedAt: number;
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
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly pendingRedirectRegistration?: {
    readonly provider: "gemini";
  };
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

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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

function validateOAuthUrl(url: URL, field: string): void {
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      `${field} must use HTTPS or an HTTP loopback origin without credentials or fragment`
    );
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

function isGeminiRedirectRegistrationCandidate(redirectUri: string): boolean {
  const url = safeUrl(redirectUri, "Invalid redirect URI");
  return (
    url.protocol === "https:" &&
    url.hostname === "oauth-redirect.googleusercontent.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    /^\/r\/user_bound_custom-mcp-[A-Za-z0-9_-]{1,512}$/u.test(url.pathname)
  );
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

/** OAuth authority. Pending login/code state is ephemeral; injected grant state survives restart. */
export class OAuthService implements OAuthTokenVerifier {
  readonly #issuer: URL;
  readonly #resource: URL;
  readonly #ownerSecretHash: string;
  readonly #now: () => number;
  readonly #audit: AuthAuditSink;
  readonly #maxDynamicClients: number;
  readonly #dynamicClientStore?: OAuthServiceOptions["dynamicClientStore"];
  readonly #staticRedirectStore?: OAuthServiceOptions["staticRedirectStore"];
  readonly #staticClientId: string | undefined;
  readonly #clients = new Map<string, RegisteredClient>();
  readonly #dynamicClientIds = new Set<string>();
  readonly #onApproved: ((clientId: string) => Promise<void>) | undefined;
  readonly #onAuthorized: ((clientId: string) => Promise<void>) | undefined;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #tokenExchangeFailureReasons = new WeakMap<object, AuthAuditReason>();
  readonly #grants: OAuthGrantStore;
  readonly #ownsGrantStore: boolean;

  constructor(options: OAuthServiceOptions) {
    this.#issuer = normalizeIssuer(options.issuer);
    this.#resource = safeUrl(options.resource, "Invalid resource");
    this.#resource.hash = "";
    validateOAuthUrl(this.#issuer, "issuer");
    validateOAuthUrl(this.#resource, "resource");
    if (this.#resource.origin !== this.#issuer.origin) {
      throw new Error("OAuth issuer and MCP resource must share an origin");
    }
    validateOwnerSecretHash(options.ownerSecretHash);
    this.#ownerSecretHash = options.ownerSecretHash;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#audit = options.audit ?? (() => undefined);
    this.#maxDynamicClients = options.maxDynamicClients ?? DEFAULT_MAX_DYNAMIC_CLIENTS;
    if (!Number.isSafeInteger(this.#maxDynamicClients) || this.#maxDynamicClients <= 0) {
      throw new RangeError("maxDynamicClients must be a positive safe integer");
    }
    this.#dynamicClientStore = options.dynamicClientStore;
    this.#staticRedirectStore = options.staticRedirectStore;
    this.#staticClientId = options.staticClient?.clientId;
    if (this.#staticRedirectStore !== undefined && this.#staticClientId === undefined) {
      throw new Error("staticRedirectStore requires a configured static client");
    }
    this.#onApproved = options.onAuthorizationApproved;
    this.#onAuthorized = options.onAuthorized;
    if (this.#dynamicClientStore !== undefined) {
      const persisted = this.#dynamicClientStore.load();
      if (persisted.length > this.#maxDynamicClients) {
        throw new RangeError("Persisted dynamic client count exceeds maxDynamicClients");
      }
      for (const record of persisted) {
        this.#clients.set(record.clientId, {
          clientId: record.clientId,
          ...(record.clientName === undefined ? {} : { clientName: record.clientName }),
          redirectUris: [...new Set(record.redirectUris.map(validateRedirectUri))],
          issuedAt: record.issuedAt
        });
        this.#dynamicClientIds.add(record.clientId);
      }
    }
    if (options.staticClient !== undefined) {
      const { clientId, clientSecret, clientName, redirectUris } = options.staticClient;
      if (this.#dynamicClientIds.has(clientId)) {
        throw new Error("Static OAuth client ID collides with a dynamic client");
      }
      const normalizedRedirects = [...new Set(redirectUris.map(validateRedirectUri))];
      if (normalizedRedirects.length > MAX_REDIRECT_URIS) {
        throw new RangeError(
          `Static client redirectUris must contain at most ${MAX_REDIRECT_URIS} entries`
        );
      }
      this.#clients.set(clientId, {
        clientId,
        clientSecret,
        ...(clientName === undefined ? {} : { clientName }),
        redirectUris: normalizedRedirects,
        issuedAt: this.#now()
      });
    }
    this.#grants = options.grantStore ?? createSqliteOAuthGrantStore();
    this.#ownsGrantStore = options.grantStore === undefined;
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
    this.#purgeExpired();
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
    this.#ensureDynamicClientCapacity();
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
    this.#dynamicClientIds.add(clientId);
    this.#persistDynamicClients();
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
    if (this.#dynamicClientIds.delete(clientId)) this.#dynamicClientIds.add(clientId);

    const redirectUri = validateRedirectUri(
      requiredString(parameters.redirect_uri, "redirect_uri")
    );
    let pendingRedirectRegistration: PendingRedirectRegistration | undefined;
    if (!client.redirectUris.includes(redirectUri)) {
      if (
        clientId !== this.#staticClientId ||
        this.#staticRedirectStore === undefined ||
        this.#dynamicClientIds.has(clientId) ||
        !isGeminiRedirectRegistrationCandidate(redirectUri)
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, "redirect_uri is not registered");
      }
      if (client.redirectUris.length >= MAX_REDIRECT_URIS) {
        throw new OAuthError(
          OAuthErrorCode.InvalidGrant,
          "redirect_uri registration capacity is exhausted"
        );
      }
      pendingRedirectRegistration = { clientId, redirectUri, provider: "gemini" };
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
      ...(parameters.state === undefined ? {} : { state: parameters.state }),
      ...(pendingRedirectRegistration === undefined ? {} : { pendingRedirectRegistration })
    };
    this.#pending.set(transactionId, pending);

    return {
      transactionId,
      clientId,
      clientName: client.clientName ?? "MCP client",
      redirectOrigin: safeUrl(redirectUri, "Invalid redirect URI").origin,
      redirectUri,
      scopes,
      expiresAt,
      ...(pendingRedirectRegistration === undefined
        ? {}
        : { pendingRedirectRegistration: { provider: pendingRedirectRegistration.provider } })
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
      clientId: pending.clientId,
      clientName: client?.clientName ?? "MCP client",
      redirectOrigin: safeUrl(pending.redirectUri, "Invalid redirect URI").origin,
      redirectUri: pending.redirectUri,
      scopes: [...pending.scopes],
      expiresAt: pending.expiresAt,
      ...(pending.pendingRedirectRegistration === undefined
        ? {}
        : {
            pendingRedirectRegistration: {
              provider: pending.pendingRedirectRegistration.provider
            }
          })
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

    const registration = pending.pendingRedirectRegistration;
    if (registration !== undefined) {
      const client = this.#clients.get(registration.clientId);
      if (
        client === undefined ||
        registration.clientId !== pending.clientId ||
        registration.clientId !== this.#staticClientId ||
        this.#dynamicClientIds.has(registration.clientId) ||
        !isGeminiRedirectRegistrationCandidate(registration.redirectUri) ||
        (!client.redirectUris.includes(registration.redirectUri) &&
          client.redirectUris.length >= MAX_REDIRECT_URIS) ||
        this.#staticRedirectStore === undefined
      ) {
        throw new Error("oauth_static_redirect_registration_invalid");
      }
      const alreadyRegistered = client.redirectUris.includes(registration.redirectUri);
      try {
        this.#staticRedirectStore.add(registration.clientId, registration.redirectUri, this.#now());
      } catch {
        this.#emit("client.persistence_failed", "failure", registration.clientId);
        throw new Error("oauth_static_redirect_persistence_failed");
      }
      this.#clients.set(registration.clientId, {
        ...client,
        redirectUris: [...new Set([...client.redirectUris, registration.redirectUri])]
      });
      if (!alreadyRegistered) {
        this.#emit(
          "static_client.redirect_registered",
          "success",
          registration.clientId,
          "owner_approved"
        );
      }
    }

    this.#pending.delete(transactionId);
    this.#emit("authorization.approved", "success", pending.clientId);
    // Owner setup is complete; fire-and-forget an auto-bind into a workspace. Binding
    // failures never fail the approval, and the client stays on the safe fallback until then.
    void this.#onApproved?.(pending.clientId).catch(() => undefined);
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

  denyAuthorization(transactionId: string): URL | undefined {
    this.#purgeExpired();
    const pending = this.#pending.get(transactionId);
    if (pending === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization transaction is invalid");
    }
    this.#pending.delete(transactionId);
    this.#emit("authorization.denied", "success", pending.clientId);
    if (pending.pendingRedirectRegistration !== undefined) return undefined;

    const redirect = safeUrl(pending.redirectUri, "Invalid redirect URI");
    redirect.searchParams.set("error", "access_denied");
    if (pending.state !== undefined) redirect.searchParams.set("state", pending.state);
    redirect.searchParams.set("iss", this.#issuer.href);
    return redirect;
  }

  exchangeAuthorizationCode(parameters: StringRecord): OAuthTokenResponse {
    this.#purgeExpired();
    if (parameters.grant_type !== "authorization_code") {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Unsupported grant_type"),
        "unsupported_grant_type"
      );
    }

    let code: string;
    try {
      code = requiredString(parameters.code, "code");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    const record = this.#codes.get(code);
    if (record === undefined) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid code"),
        "invalid_code"
      );
    }

    let clientId: string;
    try {
      clientId = requiredString(parameters.client_id, "client_id");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    try {
      this.#verifyClientSecret(clientId, parameters.client_secret);
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_client");
    }

    let redirectInput: string;
    try {
      redirectInput = requiredString(parameters.redirect_uri, "redirect_uri");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    let redirectUri: string;
    try {
      redirectUri = validateRedirectUri(redirectInput);
    } catch (error) {
      return this.#failTokenExchange(error, "redirect_mismatch");
    }
    let resourceInput: string;
    try {
      resourceInput = requiredString(parameters.resource, "resource");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    let resource: string;
    try {
      resource = exactResource(resourceInput, this.#resource);
    } catch (error) {
      return this.#failTokenExchange(error, "resource_mismatch");
    }
    let verifier: string;
    try {
      verifier = requiredString(parameters.code_verifier, "code_verifier");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }

    if (record.clientId !== clientId) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code binding failed"),
        "client_mismatch"
      );
    }
    if (record.redirectUri !== redirectUri) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code binding failed"),
        "redirect_mismatch"
      );
    }
    if (record.resource !== resource) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code binding failed"),
        "resource_mismatch"
      );
    }
    let verifierChallenge: string;
    try {
      verifierChallenge = this.pkceChallenge(verifier);
    } catch (error) {
      return this.#failTokenExchange(error, "pkce_mismatch");
    }
    if (verifierChallenge !== record.codeChallenge) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code binding failed"),
        "pkce_mismatch"
      );
    }

    try {
      return this.#issueTokens(record.clientId, record.resource, record.scopes, "token.issued", {
        onCommitted: () => {
          this.#codes.delete(code);
        }
      });
    } catch (error) {
      return this.#failTokenExchange(error, "grant_store_failure");
    }
  }

  exchangeRefreshToken(parameters: StringRecord): OAuthTokenResponse {
    this.#purgeExpired();
    if (parameters.grant_type !== "refresh_token") {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Unsupported grant_type"),
        "unsupported_grant_type"
      );
    }

    let token: string;
    try {
      token = requiredString(parameters.refresh_token, "refresh_token");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    const record = this.#grants.findToken(hashToken(token), "refresh", this.#now());
    if (record === undefined) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid refresh token"),
        "invalid_refresh_token"
      );
    }

    let clientId: string;
    try {
      clientId = requiredString(parameters.client_id, "client_id");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    try {
      this.#verifyClientSecret(clientId, parameters.client_secret);
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_client");
    }
    let resourceInput: string;
    try {
      resourceInput = requiredString(parameters.resource, "resource");
    } catch (error) {
      return this.#failTokenExchange(error, "invalid_request");
    }
    let resource: string;
    try {
      resource = exactResource(resourceInput, this.#resource);
    } catch (error) {
      return this.#failTokenExchange(error, "resource_mismatch");
    }
    if (record.clientId !== clientId) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token binding failed"),
        "client_mismatch"
      );
    }
    if (record.resource !== resource) {
      return this.#failTokenExchange(
        new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token binding failed"),
        "resource_mismatch"
      );
    }

    try {
      return this.#issueTokens(record.clientId, record.resource, record.scopes, "token.refreshed", {
        existingGrantId: record.grantId,
        refreshHash: hashToken(token)
      });
    } catch (error) {
      return this.#failTokenExchange(
        error,
        error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant
          ? "refresh_rotation_failed"
          : "grant_store_failure"
      );
    }
  }

  recordTokenExchangeFailure(error: unknown, clientId?: string): void {
    const marked =
      typeof error === "object" && error !== null
        ? this.#tokenExchangeFailureReasons.get(error)
        : undefined;
    const reason = marked ?? this.#genericTokenExchangeFailureReason(error);
    const safeClientId =
      clientId !== undefined && this.#clients.has(clientId) ? clientId : undefined;
    this.#emit("token.exchange_rejected", "failure", safeClientId, reason, "token_exchange");
  }

  revokeToken(parameters: StringRecord): void {
    this.#purgeExpired();
    const token = requiredString(parameters.token, "token");
    const clientId = requiredString(parameters.client_id, "client_id");
    this.#verifyClientSecret(clientId, parameters.client_secret);

    const hinted =
      parameters.token_type_hint === "access_token"
        ? this.#grants.findToken(hashToken(token), "access", this.#now())
        : parameters.token_type_hint === "refresh_token"
          ? this.#grants.findToken(hashToken(token), "refresh", this.#now())
          : undefined;
    const record =
      hinted ??
      this.#grants.findToken(hashToken(token), "access", this.#now()) ??
      this.#grants.findToken(hashToken(token), "refresh", this.#now());
    if (record === undefined) {
      this.#emit("token.revoked", "ignored", clientId, "invalid_token");
      return;
    }
    if (record.clientId !== clientId) {
      this.#emit("token.revoked", "ignored", clientId, "client_mismatch");
      return;
    }

    this.#grants.revokeGrant(record.grantId);
    this.#emit("token.revoked", "success", clientId);
  }

  /** Owner-authorized control-plane revocation; never logs or returns token material. */
  revokeTokenByOwner(token: string): boolean {
    this.#purgeExpired();
    const record =
      this.#grants.findToken(hashToken(token), "access", this.#now()) ??
      this.#grants.findToken(hashToken(token), "refresh", this.#now());
    if (record === undefined) return false;
    this.#grants.revokeGrant(record.grantId);
    this.#emit("token.revoked", "success", record.clientId);
    return true;
  }

  /** Revoke every ephemeral authorization artifact and grant across all dynamic clients. */
  revokeAllByOwner(): { readonly clients: number; readonly grants: number } {
    this.#purgeExpired();
    const clientIds = new Set<string>();
    const grantIds = new Set<string>();
    for (const value of this.#pending.values()) clientIds.add(value.clientId);
    for (const value of this.#codes.values()) clientIds.add(value.clientId);
    for (const value of this.#grants.listConnections(this.#now())) {
      clientIds.add(value.clientId);
      grantIds.add(value.grantId);
    }
    this.#pending.clear();
    this.#codes.clear();
    this.#grants.revokeAll();
    for (const clientId of this.#dynamicClientIds) this.#clients.delete(clientId);
    this.#dynamicClientIds.clear();
    this.#persistDynamicClients();
    for (const clientId of clientIds) this.#emit("token.revoked", "success", clientId);
    return { clients: clientIds.size, grants: grantIds.size };
  }

  /** Revoke every ephemeral authorization artifact and grant owned by one client. */
  revokeClientByOwner(clientId: string): boolean {
    this.#purgeExpired();
    const known = this.#clients.has(clientId);
    for (const [key, value] of this.#pending) {
      if (value.clientId === clientId) this.#pending.delete(key);
    }
    for (const [key, value] of this.#codes) {
      if (value.clientId === clientId) this.#codes.delete(key);
    }
    this.#grants.revokeClient(clientId);
    if (this.#dynamicClientIds.delete(clientId)) this.#clients.delete(clientId);
    this.#persistDynamicClients();
    if (known) this.#emit("token.revoked", "success", clientId);
    return known;
  }

  recordRateLimit(
    operation: "registration" | "authorization" | "token" | "owner_authentication"
  ): void {
    this.#emit("rate_limit.triggered", "failure", undefined, undefined, operation);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.#purgeExpired();
    const record = this.#accessRecord(token);
    return {
      token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      resource: safeUrl(record.resource, "Invalid resource")
    };
  }

  /** Resolve fresh on EVERY exchange, not once per cached MCP transport session. */
  async authenticateConnection(token: string): Promise<AuthenticatedConnection> {
    const record = this.#accessRecord(token);
    return {
      clientId: record.clientId,
      grantId: record.grantId,
      connectionId: record.connectionId,
      scopes: [...record.scopes],
      resource: record.resource,
      surfaceProfile: record.surfaceProfile
    };
  }

  /** Caller supplies the authenticated bearer, never a caller-selected grantId. */
  restrictConnection(token: string, profile: SurfaceProfile): AuthenticatedConnection {
    this.#accessRecord(token);
    return this.#grants.restrictByAccessToken(hashToken(token), profile, this.#now());
  }

  /** Only closes the compatibility store owned by this service. Injected store belongs to caller. */
  close(): void {
    if (this.#ownsGrantStore) this.#grants.close();
  }

  #accessRecord(token: string): VerifiedGrantToken {
    const record = this.#grants.findToken(hashToken(token), "access", this.#now());
    if (
      record === undefined ||
      record.resource !== this.#resource.href ||
      !this.#clients.has(record.clientId)
    ) {
      this.#emit("token.rejected", "failure", undefined, "invalid_token");
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
    }
    return record;
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
    options: {
      readonly existingGrantId?: string;
      readonly refreshHash?: string;
      readonly onCommitted?: () => void;
    } = {}
  ): OAuthTokenResponse {
    const now = this.#now();
    const accessToken = randomIdentifier("at");
    const refreshToken = randomIdentifier("rt");
    const grantId = options.existingGrantId ?? randomIdentifier("grant");
    const tokens = [
      {
        tokenHash: hashToken(accessToken),
        kind: "access" as const,
        expiresAt: now + ACCESS_TOKEN_TTL_SECONDS
      },
      {
        tokenHash: hashToken(refreshToken),
        kind: "refresh" as const,
        expiresAt: now + REFRESH_TOKEN_TTL_SECONDS
      }
    ];
    if (options.refreshHash === undefined) {
      this.#grants.issue({ grantId, clientId, resource, scopes }, tokens, now);
    } else if (!this.#grants.rotate(options.refreshHash, clientId, resource, tokens, now)) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Invalid refresh token");
    }
    options.onCommitted?.();
    this.#emit(auditType, "success", clientId);
    // Fire-and-forget: an authenticated client is auto-bound into a workspace (idempotent).
    void this.#onAuthorized?.(clientId).catch(() => undefined);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      resource
    };
  }

  #persistDynamicClients(): void {
    const store = this.#dynamicClientStore;
    if (store === undefined) return;
    const records: DynamicClientRecord[] = [];
    for (const clientId of this.#dynamicClientIds) {
      const client = this.#clients.get(clientId);
      if (client === undefined) continue;
      records.push({
        clientId: client.clientId,
        ...(client.clientName === undefined ? {} : { clientName: client.clientName }),
        redirectUris: [...client.redirectUris],
        issuedAt: client.issuedAt
      });
    }
    try {
      store.save(records);
    } catch {
      this.#emit("client.persistence_failed", "failure");
    }
  }

  #ensureDynamicClientCapacity(): void {
    if (this.#dynamicClientIds.size < this.#maxDynamicClients) return;

    for (const clientId of this.#dynamicClientIds) {
      if (this.#clientHasActiveState(clientId)) continue;
      this.#dynamicClientIds.delete(clientId);
      this.#clients.delete(clientId);
      this.#persistDynamicClients();
      this.#emit("client.evicted", "success", clientId);
      return;
    }

    throw new OAuthError(
      OAuthErrorCode.TooManyRequests,
      "Dynamic client capacity is temporarily exhausted"
    );
  }

  #clientHasActiveState(clientId: string): boolean {
    return (
      [...this.#pending.values()].some((record) => record.clientId === clientId) ||
      [...this.#codes.values()].some((record) => record.clientId === clientId) ||
      this.#grants.hasClient(clientId, this.#now())
    );
  }

  #failTokenExchange(error: unknown, reason: AuthAuditReason): never {
    if (typeof error === "object" && error !== null) {
      this.#tokenExchangeFailureReasons.set(error, reason);
    }
    throw error;
  }

  #genericTokenExchangeFailureReason(error: unknown): AuthAuditReason {
    if (!(error instanceof OAuthError)) return "server_error";
    if (error.code === OAuthErrorCode.InvalidClient) return "invalid_client";
    if (error.code === OAuthErrorCode.UnsupportedGrantType) return "unsupported_grant_type";
    if (error.code === OAuthErrorCode.InvalidTarget) return "resource_mismatch";
    if (error.code === OAuthErrorCode.InvalidGrant) return "invalid_code";
    if (error.code === OAuthErrorCode.InvalidRequest) return "invalid_request";
    return "server_error";
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
    this.#grants.prune(now);
  }
}
