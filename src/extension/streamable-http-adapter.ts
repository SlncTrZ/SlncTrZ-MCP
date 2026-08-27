/**
 * Streamable HTTP Extension Adapter — one isolated provider over HTTPS MCP.
 * Wing: extension | Topic: http-adapter | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 2.
 *
 * Talks the MCP Streamable HTTP transport against a fixed HTTPS endpoint from the
 * manifest. It enforces HTTPS-only, a per-request timeout driven by AbortSignal, bounded
 * output, and refuses any redirect that downgrades to http. It never accepts a caller-
 * selected endpoint, command, argv, or extra header. Provider logic never runs in-process.
 */

import {
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "./adapter.js";
import { AdapterError } from "./adapter.js";
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
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Follow up to MAX_REDIRECTS but refuse any downgrade to http. */
async function fetchWithRedirectGuard(url: URL, init: RequestInit): Promise<Response> {
  let current = new URL(url);
  let redirects = 0;

  while (true) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      headers: { ...init.headers, "content-type": "application/json" }
    });
    if (response.status >= 300 && response.status < 400) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new AdapterError("provider_unavailable", "too many redirects");
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new AdapterError("provider_protocol_error", "redirect without location");
      }
      const next = new URL(location, current);
      if (next.protocol !== "https:") {
        throw new AdapterError("provider_protocol_error", "redirect downgraded below https");
      }
      current = next;
      continue;
    }
    return response;
  }
}

/**
 * Create a Streamable HTTP adapter bound to one compiled manifest. The endpoint is the
 * fixed operator HTTPS URL; a caller never chooses a destination.
 */
export function createStreamableHttpAdapter(manifest: CompiledExtensionManifest): ExtensionAdapter {
  const endpoint = manifest.endpoint;
  if (endpoint === undefined) {
    throw new AdapterError("provider_unavailable", "http adapter requires an endpoint");
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new AdapterError("provider_unavailable", "http adapter requires a valid https endpoint");
  }
  if (base.protocol !== "https:") {
    throw new AdapterError("provider_unavailable", "http adapter requires https");
  }

  const transportHeaders = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": INITIALIZE_PROTOCOL
  };

  const post = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const init: RequestInit = {
      method: "POST",
      headers: { ...transportHeaders },
      body
    };
    if (signal !== undefined) init.signal = signal;
    const response = await fetchWithRedirectGuard(base, init);
    if (!response.ok) {
      throw new AdapterError("provider_unavailable", `http ${response.status}`);
    }
    const text = await response.text();
    if (text.length > manifest.maxMessageBytes) {
      throw new AdapterError("provider_protocol_error", "message exceeds the byte cap");
    }
    let parsed: HttpProviderMessage;
    try {
      parsed = JSON.parse(text) as HttpProviderMessage;
    } catch {
      throw new AdapterError("provider_protocol_error", "invalid JSON response");
    }
    if (parsed.error !== undefined) {
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    }
    return parsed.result;
  };

  return {
    async start(): Promise<void> {
      // No persistent connection; readiness is confirmed by a protocol version exchange.
      await post("initialize", {
        protocolVersion: INITIALIZE_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "slnctrz", version: "0.1.0" }
      });
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      const result = (await post("tools/list", {})) as ListToolsResult;
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
      const controller = new AbortController();
      const caller = options.signal;
      const linkAbort = (): void => controller.abort();
      caller?.addEventListener("abort", linkAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), manifest.requestTimeoutMs ?? 30_000);
      timer.unref();
      try {
        const result = (await post(
          "tools/call",
          { name: toolId, arguments: args },
          controller.signal
        )) as CallToolResult;
        return {
          isError: result.isError === true,
          truncated: false,
          text: (result.content ?? [])
            .map((content) => content.text ?? "")
            .join("\n")
            .slice(-manifest.maxOutputBytes)
        };
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener("abort", linkAbort);
      }
    },

    async stop(): Promise<void> {
      // Stateless HTTP: no persistent connection to release.
    },

    health(): AdapterHealth {
      return "ready";
    }
  };
}
