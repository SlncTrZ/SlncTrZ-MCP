import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpProviderStore } from "../../src/owner/mcp-provider-store.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-provider-store-"));
  cleanup.push(root);
  const file = join(root, "mcp", "providers.json");
  return { file, store: createMcpProviderStore(file) };
}

const manifest = {
  id: "github",
  transport: "streamable-http" as const,
  version: "1.0.0",
  endpoint: "https://provider.example.com/mcp",
  tools: [{ canonicalId: "github.search", riskClass: "read" as const }],
  credentialRefs: ["github-token"]
};

describe("managed MCP provider store", () => {
  it("persists validated non-secret provider records atomically", async () => {
    const { file, store } = await fixture();
    const saved = await store.upsert({ manifest, name: "GitHub", enabled: true });
    expect(saved.id).toBe("github");
    expect(saved.enabled).toBe(true);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.credentialRefs).toEqual(["github-token"]);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain('"schemaVersion": 1');
    expect(raw).not.toContain("Bearer ");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("updates by provider id without duplicating entries", async () => {
    const { store } = await fixture();
    await store.upsert({ manifest, name: "GitHub" });
    await store.upsert({ manifest: { ...manifest, version: "2.0.0" }, enabled: false });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.version).toBe("2.0.0");
    expect(listed[0]?.enabled).toBe(false);
    expect(listed[0]?.name).toBe("GitHub");
  });

  it("removes providers and reports missing removals", async () => {
    const { store } = await fixture();
    await store.upsert({ manifest });
    await expect(store.remove("github")).resolves.toBe(true);
    await expect(store.remove("github")).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects persisted providers without an accepted tool set", async () => {
    const { store } = await fixture();
    await expect(store.upsert({ manifest: { ...manifest, tools: [] } })).rejects.toThrow(
      "mcp_provider_tools_required"
    );
  });

  it("rejects invalid or inline-secret provider configuration", async () => {
    const { store } = await fixture();
    await expect(
      store.upsert({
        manifest: { ...manifest, endpoint: "http://provider.example.com/mcp" }
      })
    ).rejects.toThrow();
    await expect(
      store.upsert({
        manifest: { ...manifest, credentialRefs: ["sk_live_SECRET"] }
      })
    ).rejects.toThrow();
  });
});
