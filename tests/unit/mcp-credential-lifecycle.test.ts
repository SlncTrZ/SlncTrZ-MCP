import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import { compileExtensionRegistry } from "../../src/extension/registry.js";
import {
  createExtensionRuntimeCatalog,
  type ExtensionRuntimeCatalog
} from "../../src/extension/runtime.js";
import { createMcpCredentialStore } from "../../src/owner/mcp-credential-store.js";
import { createMcpOwnerOrchestrator } from "../../src/owner/mcp-owner-orchestrator.js";
import { createMcpProviderService } from "../../src/owner/mcp-provider-service.js";
import { createMcpProviderStore } from "../../src/owner/mcp-provider-store.js";

describe("MCP credential activation lifecycle", () => {
  it("reports committed only after the active runtime uses the rotated credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-credential-activation-"));
    let active: ExtensionRuntimeCatalog | undefined;
    try {
      const script = join(root, "provider.cjs");
      await writeFile(
        script,
        [
          'process.stdin.setEncoding("utf8");',
          'let carry = "";',
          'process.stdin.on("data", (chunk) => {',
          "  carry += chunk;",
          '  while (carry.includes("\\n")) {',
          '    const index = carry.indexOf("\\n");',
          "    const line = carry.slice(0, index);",
          "    carry = carry.slice(index + 1);",
          "    if (!line) continue;",
          "    const request = JSON.parse(line);",
          "    let result;",
          '    if (request.method === "initialize") result = { protocolVersion: "2025-11-25" };',
          '    else if (request.method === "tools/list") result = { tools: [{ name: "echo" }] };',
          '    else result = { content: [{ type: "text", text: process.env.MOCK_TOKEN ?? "missing" }] };',
          '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
          "  }",
          "});"
        ].join("\n"),
        "utf8"
      );

      const credentialStore = createMcpCredentialStore(join(root, "credentials"));
      const providerStore = createMcpProviderStore(join(root, "providers.json"));
      const oldRef = "demo-credential";
      await credentialStore.set(oldRef, { kind: "env", name: "MOCK_TOKEN", value: "OLD" });
      const manifest: ExtensionManifestV1 = {
        id: "demo",
        version: "1",
        transport: "stdio",
        command: process.execPath,
        args: [script],
        envAllowlist: ["MOCK_TOKEN"],
        credentialRefs: [oldRef],
        tools: [{ canonicalId: "demo.echo", riskClass: "read" }],
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000
      };
      await providerStore.upsert({ manifest, enabled: true });

      const buildRuntime = async (): Promise<ExtensionRuntimeCatalog> => {
        const enabled = (await providerStore.list())
          .filter((provider) => provider.enabled)
          .map((provider) => provider.manifest);
        return createExtensionRuntimeCatalog(
          await compileExtensionRegistry(enabled),
          undefined,
          (refs) => credentialStore.resolve(refs)
        );
      };
      active = await buildRuntime();
      const before = await active.provider("demo")?.invoke("echo", {});
      expect(before?.text).toBe("OLD");

      let generation = 1;
      const providerService = createMcpProviderService({
        store: providerStore,
        resolveCredentials: (refs) => credentialStore.resolve(refs),
        policyStore: {
          async reload() {
            const next = await buildRuntime();
            const prior = active;
            active = next;
            prior?.retire();
            generation += 1;
            return {
              activated: true,
              previousVersion: String(generation - 1),
              activeVersion: String(generation),
              riskIncrease: false,
              result: "activated"
            };
          }
        }
      });
      const orchestrator = createMcpOwnerOrchestrator({
        credentials: credentialStore,
        providers: providerService
      });

      const result = await orchestrator.updateAuth({
        providerId: "demo",
        auth: { kind: "env", name: "MOCK_TOKEN", value: "NEW" }
      });
      expect(result.status).toBe("committed");
      expect(result.completedSteps).toEqual([
        "credential_saved",
        "provider_probed",
        "provider_saved"
      ]);

      const after = await active.provider("demo")?.invoke("echo", {});
      expect(after?.text).toBe("NEW");
      const current = (await providerStore.list())[0];
      const newRef = current?.manifest.credentialRefs?.[0];
      expect(newRef).toBeDefined();
      expect(newRef).not.toBe(oldRef);
      expect(await credentialStore.resolve([newRef ?? ""])).toEqual([
        { kind: "env", name: "MOCK_TOKEN", value: "NEW" }
      ]);
      await expect(credentialStore.resolve([oldRef])).rejects.toThrow("mcp_credential_not_found");
    } finally {
      await active?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
