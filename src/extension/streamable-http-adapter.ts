/**
 * Streamable HTTP Extension Adapter — one isolated provider over HTTPS MCP.
 *
 * Negotiates the modern 2026-07-28 stateless era with `server/discover` and falls back
 * to the 2025 legacy initialize/session flow. Requests remain bound to one fixed HTTPS
 * endpoint, same-origin redirects only, bounded bodies, explicit credentials and timeouts.
 */

import {
  AdapterError,
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo,
  type ProviderCredential
} from "./adapter.js";
import { APP_VERSION } from "../shared/build-info.js";
import { type CompiledExtensionManifest } from "./manifest.js";
import { isLoopbackHost } from "./loopback.js";

const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const MAX_REDIRECTS = 3;
const CLIENT_INFO = { name: "slnctrz", version: APP_VERSION } as const;

type ProtocolEra = "modern" | "legacy";

interface ListToolsResult {
  readonly tools?: readonly { readonly name?: string; readonly description?: string }[];
}

interface CallToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** JSON-RPC `result` payloads surfaced by the adapter, narrowable per method at each call site. */
type ProviderResult =
  DiscoverResult | ListToolsResult | CallToolResult | { readonly protocolVersion?: unknown };

interface DiscoverResult {
  readonly supportedVersions?: readonly string[];
}

interface HttpProviderMessage {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  return { text: bytes.subarray(0, limit).toString("utf8"), truncated: true };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    controller.abort();
    throw new AdapterError("provider_protocol_error", "response exceeds message cap");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        await reader.cancel();
        throw new AdapterError("provider_protocol_error", "response exceeds message cap");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function fetchWithRedirectGuard(
  url: URL,
  init: RequestInit,
  controller: AbortController
): Promise<Response> {
  const origin = url.origin;
  // `url` is already a validated URL object and is never mutated (only reassigned on
  // redirect), so there is no need to re-parse it into a throw-prone clone.
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: "manual",
        headers: { ...init.headers, "content-type": "application/json" }
      });
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    }
    if (response.status < 300 || response.status >= 400) return response;
    if (redirects >= MAX_REDIRECTS) {
      controller.abort();
      throw new AdapterError("provider_unavailable", "too many redirects");
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new AdapterError("provider_protocol_error", "redirect without location");
    }
    const next = new URL(location, current);
    // Same-origin only (scheme + host + port). Preserves the HTTPS-only no-downgrade
    // guarantee while allowing loopback-http endpoints to follow same-origin redirects.
    if (next.origin !== origin) {
      throw new AdapterError("provider_protocol_error", "redirect leaves fixed origin");
    }
    current = next;
  }
}

function parseProviderMessage(text: string, contentType: string | null): HttpProviderMessage {
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    let fallback: HttpProviderMessage | undefined;
    for (const block of text.split(/\r?\n\r?\n/u)) {
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length === 0) continue;
      try {
        const parsed = JSON.parse(data) as HttpProviderMessage;
        fallback ??= parsed;
        // Request responses carry id=1; skip progress/log notifications that may precede it.
        if (parsed.id === 1) return parsed;
      } catch {
        continue;
      }
    }
    if (fallback !== undefined) return fallback;
    throw new AdapterError("provider_protocol_error", "invalid SSE response");
  }
  try {
    return JSON.parse(text) as HttpProviderMessage;
  } catch {
    throw new AdapterError("provider_protocol_error", "invalid JSON response");
  }
}

function asResult(message: HttpProviderMessage): ProviderResult {
  if (message.error !== undefined) {
    throw new AdapterError("provider_unavailable", "provider_unavailable");
  }
  return message.result as ProviderResult;
}

function providerHeaders(
  credentials: readonly ProviderCredential[]
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  const denied = new Set([
    "accept",
    "content-type",
    "content-length",
    "host",
    "mcp-session-id",
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name"
  ]);
  for (const credential of credentials) {
    if (credential.kind === "env") continue;
    if (credential.kind === "bearer") {
      if (headers.authorization !== undefined) {
        throw new AdapterError("provider_unavailable", "duplicate authorization credential");
      }
      headers.authorization = `Bearer ${credential.value}`;
      continue;
    }
    const key = credential.name.toLowerCase();
    if (denied.has(key) || key === "authorization" || headers[key] !== undefined) {
      throw new AdapterError("provider_unavailable", "invalid provider credential header");
    }
    headers[key] = credential.value;
  }
  return Object.freeze(headers);
}

/** Create an adapter bound to one fixed HTTPS extension endpoint. */
export function createStreamableHttpAdapter(
  manifest: CompiledExtensionManifest,
  credentials: readonly ProviderCredential[] = []
): ExtensionAdapter {
  const endpoint = manifest.endpoint;
  if (endpoint === undefined) {
    throw new AdapterError("provider_unavailable", "http adapter requires an endpoint");
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new AdapterError("provider_unavailable", "http adapter requires valid https endpoint");
  }
  // HTTPS-only by default; the sole controlled exception is an http: endpoint whose host
  // is a loopback address (see adr-025). Fail-closed for every other host.
  const httpLoopback = base.protocol === "http:" && isLoopbackHost(base.hostname);
  if (base.protocol !== "https:" && !httpLoopback) {
    throw new AdapterError("provider_unavailable", "http adapter requires https");
  }

  const credentialHeaders = providerHeaders(credentials);
  let ready = false;
  let era: ProtocolEra = "modern";
  let protocolVersion = MODERN_PROTOCOL;
  let sessionId: string | undefined;

  const requestHeaders = (
    method: string,
    params: Record<string, unknown>,
    requestEra: ProtocolEra
  ): Record<string, string> => ({
    ...credentialHeaders,
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion,
    ...(requestEra === "modern"
      ? {
          "mcp-method": method,
          ...(method === "tools/call" && typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {})
        }
      : sessionId === undefined
        ? {}
        : { "mcp-session-id": sessionId })
  });

  const requestParams = (
    params: Record<string, unknown>,
    requestEra: ProtocolEra
  ): Record<string, unknown> =>
    requestEra === "legacy"
      ? params
      : {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        };

  const postMessage = async (
    method: string,
    params: Record<string, unknown>,
    controller: AbortController,
    requestEra: ProtocolEra
  ): Promise<HttpProviderMessage> => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: requestParams(params, requestEra)
    });
    if (Buffer.byteLength(body, "utf8") > manifest.maxMessageBytes) {
      throw new AdapterError("provider_protocol_error", "request exceeds message cap");
    }
    const response = await fetchWithRedirectGuard(
      base,
      {
        method: "POST",
        headers: requestHeaders(method, params, requestEra),
        body,
        signal: controller.signal
      },
      controller
    );
    if (!response.ok) {
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    }
    if (requestEra === "legacy") {
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId !== null && nextSessionId.length > 0) sessionId = nextSessionId;
    }
    const text = await readBoundedBody(response, manifest.maxMessageBytes, controller);
    return parseProviderMessage(text, response.headers.get("content-type"));
  };

  const post = async (
    method: string,
    params: Record<string, unknown>,
    controller: AbortController,
    requestEra: ProtocolEra = era
  ): Promise<unknown> => asResult(await postMessage(method, params, controller, requestEra));

  const postWithTimeout = async (
    method: string,
    params: Record<string, unknown>,
    caller?: AbortSignal,
    requestEra: ProtocolEra = era
  ): Promise<unknown> => {
    const controller = new AbortController();
    let timedOut = false;
    const linkAbort = (): void => controller.abort();
    if (caller?.aborted === true) controller.abort();
    caller?.addEventListener("abort", linkAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, manifest.requestTimeoutMs);
    timer.unref();
    try {
      return await post(method, params, controller, requestEra);
    } catch (error) {
      if (timedOut) throw new AdapterError("provider_timeout", "provider_timeout");
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", linkAbort);
    }
  };

  const sendLegacyInitialized = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), manifest.requestTimeoutMs);
    timer.unref();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    try {
      const response = await fetchWithRedirectGuard(
        base,
        {
          method: "POST",
          headers: requestHeaders("notifications/initialized", {}, "legacy"),
          body,
          signal: controller.signal
        },
        controller
      );
      if (!response.ok) throw new AdapterError("provider_unavailable", "provider_unavailable");
    } finally {
      clearTimeout(timer);
    }
  };

  const startLegacy = async (): Promise<void> => {
    era = "legacy";
    protocolVersion = LEGACY_PROTOCOL;
    sessionId = undefined;
    const initialized = (await postWithTimeout(
      "initialize",
      {
        protocolVersion: LEGACY_PROTOCOL,
        capabilities: {},
        clientInfo: CLIENT_INFO
      },
      undefined,
      "legacy"
    )) as { protocolVersion?: unknown };
    if (
      typeof initialized.protocolVersion !== "string" ||
      initialized.protocolVersion.length === 0 ||
      initialized.protocolVersion === MODERN_PROTOCOL
    ) {
      throw new AdapterError("provider_protocol_error", "invalid legacy protocol negotiation");
    }
    protocolVersion = initialized.protocolVersion;
    await sendLegacyInitialized();
  };

  return {
    async start(): Promise<void> {
      ready = false;
      era = "modern";
      protocolVersion = MODERN_PROTOCOL;
      sessionId = undefined;
      try {
        const discovery = (await postWithTimeout(
          "server/discover",
          {},
          undefined,
          "modern"
        )) as DiscoverResult;
        if (discovery.supportedVersions?.includes(MODERN_PROTOCOL) !== true) {
          await startLegacy();
        }
      } catch (error) {
        // A reachable 2025-era server commonly rejects server/discover. Retry using the
        // legacy handshake; actual network/protocol failure is still surfaced if that fails.
        void error;
        await startLegacy();
      }
      ready = true;
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      const result = (await postWithTimeout("tools/list", {})) as ListToolsResult;
      return (result.tools ?? [])
        .filter((tool) => tool.name !== undefined)
        .map((tool) => ({
          canonicalId: tool.name ?? "",
          exposedName: tool.name ?? "",
          riskClass: "read" as const,
          ...(tool.description === undefined ? {} : { description: tool.description })
        }));
    },

    async callTool(
      toolId: string,
      args: unknown,
      options: AdapterCallOptions
    ): Promise<ExtensionCallResult> {
      const result = (await postWithTimeout(
        "tools/call",
        { name: toolId, arguments: args },
        options.signal
      )) as CallToolResult;
      const rendered = (result.content ?? []).map((content) => content.text ?? "").join("\n");
      const bounded = truncateText(rendered, manifest.maxOutputBytes);
      return { isError: result.isError === true, truncated: bounded.truncated, text: bounded.text };
    },

    async stop(): Promise<void> {
      ready = false;
      sessionId = undefined;
    },

    health(): AdapterHealth {
      return ready ? "ready" : "unavailable";
    }
  };
}
