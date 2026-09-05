import { describe, expect, it } from "vitest";
import {
  compileExtensionRegistry,
  type CompiledExtensionRegistry,
  type ExtensionRegistryError
} from "../../src/extension/registry.js";
import { type compileExtensionManifest } from "../../src/extension/manifest.js";

async function stdioManifest(
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<Parameters<typeof compileExtensionManifest>[0]> {
  return {
    id,
    transport: "stdio",
    version: "1.0.0",
    command: `/usr/local/bin/${id}-mcp`,
    tools: [{ canonicalId: `${id}.search`, riskClass: "read" }],
    envAllowlist: [`${id.toUpperCase()}_TOKEN`],
    credentialRefs: [`cred.${id}`],
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    maxOutputBytes: 1_048_576,
    maxMessageBytes: 65_536,
    maxQueue: 16,
    maxRestarts: 3,
    ...overrides
  };
}

describe("extension registry (canonical namespace, collisions, stable hash)", () => {
  it("compiles a registry and supports lookup by canonical id", async () => {
    const registry = await compileExtensionRegistry([
      await stdioManifest("github"),
      await stdioManifest("gitlab")
    ]);
    expect(registry.extensions).toHaveLength(2);
    const hit = registry.lookup("github.search");
    expect(hit?.canonicalId).toBe("github.search");
    expect(hit?.exposedName).toBe("search");
    expect(hit?.providerId).toBe("github");
  });

  it("is deeply frozen", async () => {
    const registry = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.toolIndex)).toBe(true);
    expect(() => {
      (registry as unknown as { extensions: unknown[] }).extensions.push({});
    }).toThrow();
  });

  it("is deterministic: same inputs yield the same hash", async () => {
    const a = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    const b = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("versions discovery when a declared tool contract changes", async () => {
    const readContract = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    const writeContract = await compileExtensionRegistry([
      (await stdioManifest("github", {
        tools: [{ canonicalId: "github.search", riskClass: "write" }]
      })) as never
    ]);
    expect(writeContract.hash).not.toBe(readContract.hash);
  });

  it("rejects a duplicate provider id (fatal collision)", async () => {
    await expect(
      compileExtensionRegistry([
        (await stdioManifest("github")) as never,
        (await stdioManifest("github")) as never
      ])
    ).rejects.toMatchObject({ code: "registry_collision" });
  });

  it("rejects a canonical tool id colliding across providers (same namespace misuse)", async () => {
    await expect(
      compileExtensionRegistry([
        {
          ...(await stdioManifest("github")),
          tools: [{ canonicalId: "gitlab.search", riskClass: "read" }]
        } as never,
        (await stdioManifest("gitlab")) as never
      ])
    ).rejects.toMatchObject({ code: "registry_collision" });
  });

  it("rejects a tool id not namespaced under its provider", async () => {
    await expect(
      compileExtensionRegistry([
        {
          ...(await stdioManifest("github")),
          tools: [{ canonicalId: "evil.search", riskClass: "read" }]
        } as never
      ])
    ).rejects.toMatchObject({ code: "registry_collision" });
  });

  it("denies lookup of an unknown or cross-namespace tool id", async () => {
    const registry = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    expect(registry.lookup("github.unknown")).toBeUndefined();
    expect(registry.lookup("gitlab.search")).toBeUndefined();
  });

  it("rejects more than MAX_EXTENSIONS providers (hard ceiling)", async () => {
    const manifests = [];
    for (let i = 0; i < 65; i += 1) {
      manifests.push(await stdioManifest(`ext${i}`));
    }
    await expect(compileExtensionRegistry(manifests as never)).rejects.toMatchObject({
      code: "registry_collision"
    } as Partial<ExtensionRegistryError>);
  });

  it("deep-freezes every tool record in the index, not just the collection", async () => {
    const registry = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    const tool = registry.lookup("github.search");
    expect(Object.isFrozen(tool)).toBe(true);
    expect(() => {
      (tool as unknown as { riskClass: string }).riskClass = "write";
    }).toThrow();
    expect(Object.isFrozen(registry.toolIndex)).toBe(true);
  });

  it("carries tool descriptions into the tool index for model context", async () => {
    const registry = await compileExtensionRegistry([
      {
        ...(await stdioManifest("github")),
        tools: [
          { canonicalId: "github.search", riskClass: "read", description: "Search repositories" }
        ]
      }
    ]);
    expect(registry.lookup("github.search")?.description).toBe("Search repositories");
  });
});

void (null as unknown as CompiledExtensionRegistry);
