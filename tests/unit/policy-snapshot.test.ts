import { describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import type { ExtensionRuntimeCatalog } from "../../src/extension/runtime.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";

const principal = { clientId: "fresh-client", scopes: ["mcp:tools"] };
const provider: ExtensionManifestV1 = {
  id: "demo",
  version: "1",
  transport: "streamable-http",
  endpoint: "https://example.com/mcp",
  tools: [{ canonicalId: "demo.echo", riskClass: "network" }]
};

function runtime(
  registry: ExtensionRuntimeCatalog["registry"],
  ready: boolean
): ExtensionRuntimeCatalog {
  return {
    registry,
    provider: () => undefined,
    isReady: (providerId) => ready && providerId === "demo",
    acquire: () => () => undefined,
    retire: () => undefined,
    stop: async () => undefined
  };
}

describe("simple active policy snapshot", () => {
  it("resolves every authenticated client straight to the default product snapshot", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: ["/tmp"] });
    const resolved = buildActivePolicySnapshot(compiled).resolve(principal);
    expect(resolved.workspaceId).toBe("default");
    expect(resolved.capabilities).toEqual(["core.read", "core.search", "core.write", "core.edit"]);
  });

  it("exposes every accepted tool from enabled providers passed to the compiler", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: ["/tmp"] }, undefined, [
      provider
    ]);
    const resolved = buildActivePolicySnapshot(compiled).resolve(principal);
    expect(resolved.extensions.map((tool) => tool.canonicalId)).toEqual(["demo.echo"]);
  });

  it("fingerprints only extension tools that are actually ready to be advertised", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: ["/tmp"] }, undefined, [
      provider
    ]);
    const unavailable = buildActivePolicySnapshot(
      compiled,
      runtime(compiled.extensionRegistry, false)
    );
    const ready = buildActivePolicySnapshot(compiled, runtime(compiled.extensionRegistry, true));
    expect(unavailable.toolCatalogFingerprint).not.toBe(ready.toolCatalogFingerprint);
    expect(unavailable.resolve(principal).toolCatalogFingerprint).toBe(
      unavailable.toolCatalogFingerprint
    );
    expect(ready.resolve(principal).toolCatalogFingerprint).toBe(ready.toolCatalogFingerprint);
  });

  it("keeps the advertised-tool fingerprint stable across identical generations", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: ["/tmp"] }, undefined, [
      provider
    ]);
    const first = buildActivePolicySnapshot(compiled, runtime(compiled.extensionRegistry, true));
    const second = buildActivePolicySnapshot(compiled, runtime(compiled.extensionRegistry, true));
    expect(second.toolCatalogFingerprint).toBe(first.toolCatalogFingerprint);
  });
});
