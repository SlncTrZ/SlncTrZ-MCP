import { describe, expect, it } from "vitest";
import {
  compileExtensionRegistry,
  type CompiledExtensionRegistry
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
    workspaces: ["dev"],
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
    expect(hit?.exposedName).toBe("github.search");
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

  it("enumerates only tools authorized for a workspace", async () => {
    const registry = await compileExtensionRegistry([
      { ...(await stdioManifest("github")), workspaces: ["dev"] } as never,
      {
        ...(await stdioManifest("gitlab")),
        workspaces: ["prod"] as unknown
      } as never
    ]);
    const dev = registry.listAuthorized("dev");
    const prod = registry.listAuthorized("prod");
    expect(dev.some((tool) => tool.canonicalId === "github.search")).toBe(true);
    expect(dev.some((tool) => tool.canonicalId === "gitlab.search")).toBe(false);
    expect(prod.some((tool) => tool.canonicalId === "gitlab.search")).toBe(true);
  });

  it("denies an unknown workspace (empty authorized set)", async () => {
    const registry = await compileExtensionRegistry([(await stdioManifest("github")) as never]);
    expect(registry.listAuthorized("nope")).toEqual([]);
  });
});

void (null as unknown as CompiledExtensionRegistry);
