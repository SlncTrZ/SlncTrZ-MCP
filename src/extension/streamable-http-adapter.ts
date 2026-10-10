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
import { providerIdentity } from "./provider-identity.js";
import type { ProviderIdentity } from "./adapter.js";
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

async function readSseMessage(
  response: Response,
  maxBytes: number,
  controller: AbortController
): Promise<HttpProviderMessage> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    controller.abort();
    throw new AdapterError("provider_protocol_error", "response exceeds message cap");
  }
  if (response.body === null)
    throw new AdapterError("provider_protocol_error", "missing SSE response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let skipLf = false;
  let data: string[] = [];
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  const event = (): HttpProviderMessage | undefined => {
    const text = data.join("\n");
    data = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const message = parsed as HttpProviderMessage;
        if (message.id === 1 && ("result" in message || "error" in message)) return message;
      }
    } catch {
      /* Ignore comments, notifications and malformed unrelated events. */
    }
    return undefined;
  };
  const line = (value: string): HttpProviderMessage | undefined => {
    if (value.length === 0) return event();
    if (value === "data") data.push("");
    else if (value.startsWith("data:")) {
      const valueData = value.slice(5);
      data.push(valueData.startsWith(" ") ? valueData.slice(1) : valueData);
    }
    return undefined;
  };
  try {
    if (controller.signal.aborted) abort();
    while (true) {
      const item = await reader.read();
      if (controller.signal.aborted)
        throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
      if (!item.done) {
        bytes += item.value.byteLength;
        if (bytes > maxBytes) {
          controller.abort();
          throw new AdapterError("provider_protocol_error", "response exceeds message cap");
        }
      }
      pending += item.done ? decoder.decode() : decoder.decode(item.value, { stream: true });
      while (true) {
        if (skipLf && pending.length > 0) {
          if (pending[0] === "\n") pending = pending.slice(1);
          skipLf = false;
        }
        const index = pending.search(/[\r\n]/u);
        if (index < 0) break;
        // CR is a complete line ending by itself. Suppress an optional following LF,
        // including when it arrives in a later chunk, without delaying a complete event.
        skipLf = pending[index] === "\r";
        const message = line(pending.slice(0, index));
        pending = pending.slice(index + 1);
        if (message !== undefined) return message;
      }
      if (item.done) {
        const message = pending.length > 0 ? line(pending) : undefined;
        const last = message ?? event();
        if (last !== undefined) return last;
        throw new AdapterError("provider_protocol_error", "missing matching SSE response");
      }
    }
  } finally {
    controller.signal.removeEventListener("abort", abort);
    // Do not let a provider's stream cleanup hold an already-complete RPC result open.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
      throw new AdapterError("provider_unavailable", "provider_unavailable", "transport_failure");
    }
    if (response.status < 300 || response.status >= 400) return response;
    if (redirects >= MAX_REDIRECTS) {
      controller.abort();
      throw new AdapterError("provider_unavailable", "too many redirects", "transport_failure");
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

function parseProviderMessage(text: string): HttpProviderMessage {
  try {
    return JSON.parse(text) as HttpProviderMessage;
  } catch {
    throw new AdapterError("provider_protocol_error", "invalid JSON response");
  }
}

function asResult(message: HttpProviderMessage): ProviderResult {
  if (message.error !== undefined) {
    if (message.error.code === -32601 || message.error.code === -32602) {
      throw new AdapterError("provider_request_error", "provider_request_error");
    }
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
        throw new AdapterError(
          "provider_unavailable",
          "duplicate authorization credential",
          "authorization_failure"
        );
      }
      headers.authorization = `Bearer ${credential.value}`;
      continue;
    }
    const key = credential.name.toLowerCase();
    if (denied.has(key) || key === "authorization" || headers[key] !== undefined) {
      throw new AdapterError(
        "provider_unavailable",
        "invalid provider credential header",
        "authorization_failure"
      );
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
    throw new AdapterError(
      "provider_unavailable",
      "http adapter requires an endpoint",
      "startup_unavailable"
    );
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new AdapterError(
      "provider_unavailable",
      "http adapter requires valid https endpoint",
      "startup_unavailable"
    );
  }
  // HTTPS-only by default; the sole controlled exception is an http: endpoint whose host
  // is a loopback address (see adr-025). Fail-closed for every other host.
  const httpLoopback = base.protocol === "http:" && isLoopbackHost(base.hostname);
  if (base.protocol !== "https:" && !httpLoopback) {
    throw new AdapterError(
      "provider_unavailable",
      "http adapter requires https",
      "startup_unavailable"
    );
  }

  const credentialHeaders = providerHeaders(credentials);
  let ready = false;
  let identity: ProviderIdentity | undefined;
  let era: ProtocolEra = "modern";
  let protocolVersion = MODERN_PROTOCOL;
  let sessionId: string | undefined;
  let lifecycleEpoch = 0;
  const controllers = new Set<AbortController>();
  interface RequestContext {
    readonly epoch: number;
    readonly deadlineAt?: number;
  }
  const assertCurrent = (context: RequestContext): void => {
    if (context.epoch !== lifecycleEpoch) {
      throw new AdapterError("provider_unavailable", "provider request was cancelled", "cancelled");
    }
    if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
      throw new AdapterError("provider_timeout", "provider_timeout");
    }
  };
  const cancelRequests = (): void => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const runRequest = async <T>(
    context: RequestContext,
    caller: AbortSignal | undefined,
    operation: (controller: AbortController) => Promise<T>
  ): Promise<T> => {
    assertCurrent(context);
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const linkAbort = (): void => controller.abort();
    if (caller?.aborted === true) controller.abort();
    caller?.addEventListener("abort", linkAbort, { once: true });
    const timeoutMs = Math.min(
      manifest.requestTimeoutMs,
      context.deadlineAt === undefined ? manifest.requestTimeoutMs : context.deadlineAt - Date.now()
    );
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, timeoutMs)
    );
    timer.unref();
    try {
      if (controller.signal.aborted)
        throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
      const result = await operation(controller);
      assertCurrent(context);
      if (controller.signal.aborted)
        throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
      return result;
    } catch (error) {
      assertCurrent(context);
      if (timedOut) throw new AdapterError("provider_timeout", "provider_timeout");
      // Byte/protocol guards abort their own transport; retain the original failure category.
      if (error instanceof AdapterError && error.code === "provider_protocol_error") throw error;
      if (controller.signal.aborted)
        throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "provider_unavailable", "transport_failure");
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      caller?.removeEventListener("abort", linkAbort);
    }
  };

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
    requestEra: ProtocolEra,
    context: RequestContext
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
    const hadLegacySession = requestEra === "legacy" && sessionId !== undefined;
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
    assertCurrent(context);
    if (controller.signal.aborted)
      throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
    if (!response.ok) {
      if (response.status === 404 && hadLegacySession) {
        sessionId = undefined;
        ready = false;
        throw new AdapterError(
          "provider_session_invalid",
          "provider_session_invalid",
          "session_invalid",
          undefined,
          true
        );
      }
      throw new AdapterError(
        "provider_unavailable",
        "provider_unavailable",
        response.status === 401 || response.status === 403
          ? "authorization_failure"
          : "transport_failure"
      );
    }
    if (requestEra === "legacy") {
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId !== null && nextSessionId.length > 0) sessionId = nextSessionId;
    }
    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      return readSseMessage(response, manifest.maxMessageBytes, controller);
    }
    const text = await readBoundedBody(response, manifest.maxMessageBytes, controller);
    return parseProviderMessage(text);
  };

  const postWithTimeout = async (
    method: string,
    params: Record<string, unknown>,
    caller?: AbortSignal,
    requestEra: ProtocolEra = era,
    context: RequestContext = { epoch: lifecycleEpoch }
  ): Promise<unknown> =>
    runRequest(context, caller, async (controller) =>
      asResult(await postMessage(method, params, controller, requestEra, context))
    );

  const sendLegacyInitialized = async (context: RequestContext): Promise<void> =>
    runRequest(context, undefined, async (controller) => {
      const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const hadLegacySession = sessionId !== undefined;
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
      assertCurrent(context);
      if (controller.signal.aborted)
        throw new AdapterError("provider_unavailable", "request cancelled", "cancelled");
      if (!response.ok) {
        if (response.status === 404 && hadLegacySession) {
          sessionId = undefined;
          ready = false;
          throw new AdapterError(
            "provider_session_invalid",
            "provider_session_invalid",
            "session_invalid",
            undefined,
            true
          );
        }
        throw new AdapterError(
          "provider_unavailable",
          "provider_unavailable",
          response.status === 401 || response.status === 403
            ? "authorization_failure"
            : "transport_failure"
        );
      }
    });

  const startLegacy = async (context: RequestContext): Promise<void> => {
    assertCurrent(context);
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
      "legacy",
      context
    )) as { protocolVersion?: unknown };
    assertCurrent(context);
    if (
      typeof initialized.protocolVersion !== "string" ||
      initialized.protocolVersion.length === 0 ||
      initialized.protocolVersion === MODERN_PROTOCOL
    ) {
      throw new AdapterError("provider_protocol_error", "invalid legacy protocol negotiation");
    }
    protocolVersion = initialized.protocolVersion;
    await sendLegacyInitialized(context);
    identity = providerIdentity(initialized, protocolVersion);
  };

  return {
    async start(): Promise<void> {
      const context: RequestContext = {
        epoch: ++lifecycleEpoch,
        deadlineAt: Date.now() + manifest.startupTimeoutMs
      };
      cancelRequests();
      ready = false;
      identity = undefined;
      era = "modern";
      protocolVersion = MODERN_PROTOCOL;
      sessionId = undefined;
      let discovery: DiscoverResult | undefined;
      try {
        discovery = (await postWithTimeout(
          "server/discover",
          {},
          undefined,
          "modern",
          context
        )) as DiscoverResult;
      } catch (error) {
        assertCurrent(context);
        if (
          error instanceof AdapterError &&
          (error.code === "provider_timeout" || error.failureClass === "cancelled")
        )
          throw error;
        // A reachable legacy server can reject discovery; fallback shares this startup deadline.
      }
      if (discovery?.supportedVersions?.includes(MODERN_PROTOCOL) !== true)
        await startLegacy(context);
      else identity = providerIdentity(discovery, protocolVersion);
      assertCurrent(context);
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
      lifecycleEpoch += 1;
      cancelRequests();
      ready = false;
      sessionId = undefined;
    },

    identity: () => identity,
    health(): AdapterHealth {
      return ready ? "ready" : "unavailable";
    }
  };
}
