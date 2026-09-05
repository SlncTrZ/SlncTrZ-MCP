import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStdioAdapter } from "../../src/extension/stdio-adapter.js";
import { compileExtensionManifest } from "../../src/extension/manifest.js";

async function makeServer(kind: "modern" | "legacy"): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(join(process.cwd(), ".stdio-protocol-"));
  const script = join(root, "server.mjs");
  const source =
    kind === "modern"
      ? [
          'import { McpServer } from "@modelcontextprotocol/server";',
          'import { serveStdio } from "@modelcontextprotocol/server/stdio";',
          "serveStdio(() => {",
          '  const server = new McpServer({ name: "modern-test", version: "1.0.0" });',
          '  server.registerTool("echo", { description: "echo" }, async () => ({',
          '    content: [{ type: "text", text: "modern" }]',
          "  }));",
          "  return server;",
          '}, { legacy: "reject" });'
        ].join("\n")
      : [
          'import { McpServer } from "@modelcontextprotocol/server";',
          'import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";',
          'const server = new McpServer({ name: "legacy-test", version: "1.0.0" });',
          'server.registerTool("echo", { description: "echo" }, async () => ({',
          '  content: [{ type: "text", text: "legacy" }]',
          "}));",
          "await server.connect(new StdioServerTransport());"
        ].join("\n");
  await writeFile(script, source, "utf8");
  return { root, script };
}

describe("stdio adapter protocol-era negotiation", () => {
  for (const kind of ["modern", "legacy"] as const) {
    it("interoperates with the official SDK " + kind + " stdio server", async () => {
      const fixture = await makeServer(kind);
      let adapter: ReturnType<typeof createStdioAdapter> | undefined;
      try {
        const manifest = await compileExtensionManifest({
          id: "official",
          transport: "stdio",
          version: "1.0.0",
          command: process.execPath,
          args: [fixture.script],
          tools: [{ canonicalId: "official.echo", riskClass: "read" }],
          startupTimeoutMs: 5_000,
          requestTimeoutMs: 5_000,
          maxMessageBytes: 256 * 1024,
          maxOutputBytes: 256 * 1024
        });
        adapter = createStdioAdapter(manifest);
        await adapter.start();
        expect((await adapter.listTools()).map((tool) => tool.canonicalId)).toContain("echo");
        expect((await adapter.callTool("echo", {}, {})).text).toBe(kind);
        expect(adapter.health()).toBe("ready");
      } finally {
        await adapter?.stop();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
