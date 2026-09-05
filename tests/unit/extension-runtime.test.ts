import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionRuntimeCatalog } from "../../src/extension/runtime.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A streamable-http provider on loopback whose server reports BARE tool names (standard MCP). */
const manifest: ExtensionManifestV1 = {
  id: "pi-core",
  transport: "streamable-http",
  version: "1.0.0",
  endpoint: "http://127.0.0.1:3003/mcp",
  tools: [{ canonicalId: "pi-core.run_pipeline", riskClass: "network" }],
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  maxOutputBytes: 1_048_576,
  maxMessageBytes: 65_536,
  maxQueue: 16,
  maxRestarts: 3
};

/** Drive the streamable adapter through the legacy fallback, then report the bare tool name. */
function bareServerFetch() {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
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
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    // tools/list (and any other method) → bare tool names, as a standard MCP server exposes.
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "run_pipeline" }] } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
}

describe("extension runtime catalog attestation", () => {
  it("attests a provider whose server reports bare names against namespaced declared ids", async () => {
    vi.stubGlobal("fetch", bareServerFetch());
    const registry = await compileExtensionRegistry([manifest]);
    const runtime = await createExtensionRuntimeCatalog(registry);
    // The declared canonical id is `pi-core.run_pipeline`; the server reports bare `run_pipeline`.
    // toolNameOf maps the declared id to `run_pipeline`, so attestation must pass and the
    // provider becomes ready instead of drifting as unavailable.
    expect(runtime.isReady("pi-core")).toBe(true);
    expect(runtime.provider("pi-core")).toBeDefined();
  });

  it("accepts a provider superset while the declared runtime catalog remains unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "server/discover") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nf" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "run_pipeline" }, { name: "extra_tool" }] }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const registry = await compileExtensionRegistry([manifest]);
    const runtime = await createExtensionRuntimeCatalog(registry);
    expect(runtime.isReady("pi-core")).toBe(true);
    const provider = runtime.provider("pi-core");
    expect(provider).toBeDefined();
    const result = await provider?.invoke("run_pipeline", {});
    expect(result).toBeDefined();
    expect(runtime.registry.lookup("pi-core.run_pipeline")).toBeDefined();
    expect(runtime.registry.lookup("pi-core.extra_tool")).toBeUndefined();
  });

  it("treats provider-prefixed discovered names as protocol drift", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "server/discover") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nf" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "pi-core.run_pipeline" }] }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const registry = await compileExtensionRegistry([manifest]);
    const runtime = await createExtensionRuntimeCatalog(registry);
    expect(runtime.isReady("pi-core")).toBe(false);
  });

  it("stays unavailable when the server reports only a subset of declared tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "server/discover") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nf" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "different_tool" }] }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const registry = await compileExtensionRegistry([manifest]);
    const runtime = await createExtensionRuntimeCatalog(registry);
    expect(runtime.isReady("pi-core")).toBe(false);
  });
});
