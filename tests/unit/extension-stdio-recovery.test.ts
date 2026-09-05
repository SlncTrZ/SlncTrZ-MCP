import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExtensionManifest } from "../../src/extension/manifest.js";
import { createStdioAdapter } from "../../src/extension/stdio-adapter.js";
import { createExtensionSupervisor } from "../../src/extension/supervisor.js";

describe("stdio timeout recovery", () => {
  it("restarts one dead generation and runs the next queued call on the new generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-stdio-recovery-"));
    try {
      const marker = join(root, "hung-once.marker");
      const provider = join(root, "provider.cjs");
      const source = [
        'const fs = require("node:fs");',
        "const marker = process.argv[2];",
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
        '    if (request.method === "server/discover") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '    } else if (request.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25" } }) + "\\n");',
        '    } else if (request.method === "tools/list") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo" }] } }) + "\\n");',
        '    } else if (request.method === "tools/call") {',
        '      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); continue; }',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "pong" }] } }) + "\\n");',
        "    }",
        "  }",
        "});"
      ].join("\n");
      await writeFile(provider, source, "utf8");
      const manifest = await compileExtensionManifest({
        id: "recover",
        transport: "stdio",
        version: "1.0.0",
        command: process.execPath,
        args: [provider, marker],
        tools: [{ canonicalId: "recover.echo", riskClass: "read" }],
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 50,
        maxRestarts: 2
      });
      const supervisor = createExtensionSupervisor({
        adapter: createStdioAdapter(manifest),
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 50,
        maxRestarts: 2,
        backoffBaseMs: 1,
        backoffJitterMs: 0
      });
      await supervisor.start();
      const first = await supervisor.invoke("echo", {});
      expect(first).toMatchObject({ isError: true, text: "provider_timeout" });
      expect(supervisor.state).toBe("restarting");

      const second = await supervisor.invoke("echo", {});
      expect(second).toMatchObject({ isError: false, text: "pong" });
      expect(supervisor.state).toBe("ready");

      await new Promise((resolve) => setTimeout(resolve, 100));
      const third = await supervisor.invoke("echo", {});
      expect(third).toMatchObject({ isError: false, text: "pong" });
      expect(supervisor.state).toBe("ready");
      await supervisor.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
