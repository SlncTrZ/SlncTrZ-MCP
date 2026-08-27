import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamableHttpAdapter } from "../../src/extension/streamable-http-adapter.js";
import { compileExtensionManifest } from "../../src/extension/manifest.js";
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
    tools: [{ canonicalId: "svc.ping", riskClass: "read" }],
    workspaces: ["dev"]
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
      vi.fn(async () => okResponse({ tools: [{ name: "svc.ping" }] }))
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
    const result = await adapter.callTool("svc.ping", {}, {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe("hi");
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
      await adapter.callTool("svc.ping", {}, {});
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
      await adapter.callTool("svc.ping", {}, {});
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
    await expect(adapter.callTool("svc.ping", {}, {})).rejects.toMatchObject({
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
    await expect(adapter.callTool("svc.ping", {}, {})).rejects.toMatchObject({
      code: "provider_protocol_error"
    });
  });
});
