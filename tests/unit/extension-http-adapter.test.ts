import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamableHttpAdapter } from "../../src/extension/streamable-http-adapter.js";
import { compileExtensionManifest } from "../../src/extension/manifest.js";
import { type CompiledExtensionManifest } from "../../src/extension/manifest.js";
import { AdapterError } from "../../src/extension/adapter.js";
import { type ExtensionManifestV1 } from "../../src/extension/manifest.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function httpsManifest(endpoint: string): ExtensionManifestV1 {
  return {
    id: "svc",
    transport: "streamable-http",
    version: "1.0.0",
    endpoint,
    tools: [{ canonicalId: "svc.ping", riskClass: "read" }]
  };
}

function httpManifest(endpoint: string): ExtensionManifestV1 {
  return {
    id: "svc",
    transport: "streamable-http",
    version: "1.0.0",
    endpoint,
    tools: [{ canonicalId: "svc.ping", riskClass: "read" }]
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("streamable http adapter (integration against real fetch)", () => {
  it("lists tools and calls one through the HTTPS endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        return body.method === "server/discover"
          ? okResponse({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } })
          : okResponse({ tools: [{ name: "svc.ping" }] });
      })
    );
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await adapter.start();
    const tools = await adapter.listTools();
    expect(tools.map((t) => t.canonicalId)).toContain("svc.ping");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ content: [{ type: "text", text: "hi" }] }))
    );
    const result = await adapter.callTool("ping", {}, {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe("hi");
  });

  it("forwards provider-local dotted tool names without stripping them again", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: { name?: string };
      };
      if (body.method === "server/discover") {
        return okResponse({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
      }
      if (body.method === "tools/call") {
        expect(body.params?.name).toBe("foo.bar");
        return okResponse({ content: [{ type: "text", text: "pong" }] });
      }
      return okResponse({ tools: [{ name: "foo.bar" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await adapter.start();
    const result = await adapter.callTool("foo.bar", {}, {});
    expect(result.text).toBe("pong");
  });

  it("falls back to the legacy handshake, sends initialized, and propagates the MCP session", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      if (body.method === "server/discover") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: "method not found" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-11-25" }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-123"
            }
          }
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {}
        })}\n\nevent: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "svc.ping" }] }
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await adapter.start();
    await expect(adapter.listTools()).resolves.toEqual([
      { canonicalId: "svc.ping", exposedName: "svc.ping", riskClass: "read" }
    ]);
    const initializedBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? "{}")) as {
      method?: string;
    };
    expect(initializedBody.method).toBe("notifications/initialized");
    const listHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(listHeaders["mcp-session-id"]).toBe("session-123");
    expect(listHeaders["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("uses the modern 2026 stateless era without initialize or session headers", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (body.method === "server/discover") {
        return okResponse({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
      }
      return okResponse({ tools: [{ name: "svc.ping" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await adapter.start();
    await adapter.listTools();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const discoverHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(discoverHeaders["mcp-method"]).toBe("server/discover");
    expect(discoverHeaders["mcp-session-id"]).toBeUndefined();
    const listHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(listHeaders["mcp-protocol-version"]).toBe("2026-07-28");
    expect(listHeaders["mcp-method"]).toBe("tools/list");
    expect(listHeaders["mcp-session-id"]).toBeUndefined();
    const listBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as {
      params?: { _meta?: Record<string, unknown> };
    };
    expect(listBody.params?._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("injects resolved HTTP credentials without exposing them through the manifest", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      return okResponse(
        body.method === "server/discover"
          ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
          : { tools: [] }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest, [
      { kind: "bearer", value: "secret-token" },
      { kind: "http-header", name: "X-API-Key", value: "secret-key" }
    ]);
    await adapter.start();
    const sent = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(sent.authorization).toBe("Bearer secret-token");
    expect(sent["x-api-key"]).toBe("secret-key");
  });

  it("refuses a redirect that downgrades to http", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: "http://evil.example.com" } })
      )
    );
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    let caught: unknown;
    try {
      await adapter.callTool("ping", {}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe("provider_protocol_error");
  });

  it("maps a provider error to provider_unavailable without leaking the body", async () => {
    // A JSON-RPC error is a top-level field, not nested in `result`.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    let caught: unknown;
    try {
      await adapter.callTool("ping", {}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const code = (caught as AdapterError).code;
    expect(["provider_unavailable", "provider_protocol_error"]).toContain(code);
    // The raw body text never surfaces in the error.
    expect((caught as Error).message).not.toContain("boom");
  });

  it("refuses a cross-origin HTTPS redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/mcp" }
          })
      )
    );
    const manifest = await compileExtensionManifest(httpsManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await expect(adapter.callTool("ping", {}, {})).rejects.toMatchObject({
      code: "provider_protocol_error"
    });
  });

  it("rejects a streamed response body that exceeds the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(128), { status: 200 }))
    );
    const manifest = await compileExtensionManifest({
      ...httpsManifest("https://provider.example.com"),
      maxMessageBytes: 16
    });
    const adapter = createStreamableHttpAdapter(manifest);
    await expect(adapter.callTool("ping", {}, {})).rejects.toMatchObject({
      code: "provider_protocol_error"
    });
  });

  it("accepts an http: endpoint on a loopback host (controlled exception)", async () => {
    const manifest = await compileExtensionManifest(httpManifest("http://127.0.0.1:3003/mcp"));
    expect(() => createStreamableHttpAdapter(manifest, [])).not.toThrow();
  });

  it("rejects an http: endpoint on a non-loopback host", async () => {
    expect(() =>
      createStreamableHttpAdapter(
        { ...httpsManifest("http://x.example.com/mcp") } as unknown as CompiledExtensionManifest,
        []
      )
    ).toThrowError(AdapterError);
  });

  it("starts a loopback-http provider over the modern MCP handshake", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } })
      )
    );
    const manifest = await compileExtensionManifest(httpManifest("http://127.0.0.1:3003/mcp"));
    const adapter = createStreamableHttpAdapter(manifest);
    await expect(adapter.start()).resolves.toBeUndefined();
  });

  it("blocks a redirect to a different loopback port (per-origin isolation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:3004/elsewhere" }
          })
      )
    );
    const manifest = await compileExtensionManifest(httpManifest("http://127.0.0.1:3003/mcp"));
    const adapter = createStreamableHttpAdapter(manifest);
    await expect(adapter.start()).rejects.toMatchObject({ code: "provider_protocol_error" });
  });

  it("carries the provider tool description through listTools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        return body.method === "server/discover"
          ? okResponse({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } })
          : okResponse({ tools: [{ name: "svc.ping", description: "Ping the service" }] });
      })
    );
    const manifest = await compileExtensionManifest(httpManifest("https://provider.example.com"));
    const adapter = createStreamableHttpAdapter(manifest);
    await adapter.start();
    const tools = await adapter.listTools();
    expect(tools[0]).toMatchObject({
      canonicalId: "svc.ping",
      description: "Ping the service"
    });
  });
});
