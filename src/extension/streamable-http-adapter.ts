/**
 * Streamable HTTP Extension Adapter — one isolated provider over HTTPS MCP.
 * Wing: extension | Topic: http-adapter | Updated: 2026-08-27
 *
 * Requests go only to a fixed manifest endpoint. Redirects must remain same-origin HTTPS;
 * response bodies are streamed into a byte-bounded buffer before parsing, so a provider
 * cannot allocate unbounded gateway memory. Every protocol operation has an abortable
 * timeout and raw provider failures map to stable, non-sensitive adapter errors.
 */

import {
  AdapterError,
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "./adapter.js";
import { type CompiledExtensionManifest } from "./manifest.js";

const INITIALIZE_PROTOCOL = "2025-06-18";
const MAX_REDIRECTS = 3;

interface ListToolsResult {
  readonly tools?: readonly { readonly name?: string }[];
}

interface CallToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
}

interface HttpProviderMessage {
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
  let current = new URL(url);
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
    if (next.protocol !== "https:" || next.origin !== origin) {
      throw new AdapterError("provider_protocol_error", "redirect leaves fixed https origin");
    }
    current = next;
  }
}

function asResult(message: HttpProviderMessage): unknown {
  if (message.error !== undefined) {
    throw new AdapterError("provider_unavailable", "provider_unavailable");
  }
  return message.result;
}

/** Create an adapter bound to one fixed HTTPS extension endpoint. */
export function createStreamableHttpAdapter(manifest: CompiledExtensionManifest): ExtensionAdapter {
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
  if (base.protocol !== "https:") {
    throw new AdapterError("provider_unavailable", "http adapter requires https");
  }

  let ready = false;
  const headers = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": INITIALIZE_PROTOCOL
  };

  const post = async (
    method: string,
    params: Record<string, unknown>,
    controller: AbortController
  ): Promise<unknown> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    if (Buffer.byteLength(body, "utf8") > manifest.maxMessageBytes) {
      throw new AdapterError("provider_protocol_error", "request exceeds message cap");
    }
    const response = await fetchWithRedirectGuard(
      base,
      { method: "POST", headers, body, signal: controller.signal },
      controller
    );
    if (!response.ok) {
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    }
    const text = await readBoundedBody(response, manifest.maxMessageBytes, controller);
    let parsed: HttpProviderMessage;
    try {
      parsed = JSON.parse(text) as HttpProviderMessage;
    } catch {
      throw new AdapterError("provider_protocol_error", "invalid JSON response");
    }
    return asResult(parsed);
  };

  const postWithTimeout = async (
    method: string,
    params: Record<string, unknown>,
    caller?: AbortSignal
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
      return await post(method, params, controller);
    } catch (error) {
      if (timedOut) throw new AdapterError("provider_timeout", "provider_timeout");
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", linkAbort);
    }
  };

  return {
    async start(): Promise<void> {
      await postWithTimeout("initialize", {
        protocolVersion: INITIALIZE_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "slnctrz", version: "0.1.0" }
      });
      ready = true;
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      const result = (await postWithTimeout("tools/list", {})) as ListToolsResult;
      return (result.tools ?? [])
        .filter((tool) => tool.name !== undefined)
        .map((tool) => ({
          canonicalId: tool.name ?? "",
          exposedName: tool.name ?? "",
          riskClass: "read" as const
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
    },

    health(): AdapterHealth {
      return ready ? "ready" : "unavailable";
    }
  };
}
