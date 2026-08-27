import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStdioAdapter } from "../../src/extension/stdio-adapter.js";
import { compileExtensionManifest } from "../../src/extension/manifest.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-stdio-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

/** Write an MCP mock provider: read JSON-RPC lines on stdin, reply on stdout. */
async function writeMockProvider(dir: string, behavior: "ok" | "echo_env"): Promise<string> {
  const path = join(dir, "mock-provider.js");
  const script =
    behavior === "echo_env"
      ? `process.stdin.on('data', (d) => { const l = String(d).trim(); if(!l) return; const m = JSON.parse(l); if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}})+'\\n'); else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'env='+ (process.env.MOCK_TOKEN ?? 'none')}]}})+'\\n'); });`
      : `process.stdin.on('data', (d) => { const l = String(d).trim(); if(!l) return; const m = JSON.parse(l); if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}})+'\\n'); else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'mock.echo'}]}})+'\\n'); else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}})+'\\n'); });`;
  await writeFile(path, script, "utf8");
  return path;
}

describe("stdio adapter (integration: real spawn, no fake)", () => {
  it("spawns the provider, lists tools, and calls one", async () => {
    const dir = await makeTempDir();
    const provider = await writeMockProvider(dir, "ok");
    const manifest = await compileExtensionManifest({
      id: "mock",
      transport: "stdio",
      version: "1.0.0",
      command: process.execPath, // absolute node binary
      args: [provider],
      tools: [{ canonicalId: "mock.echo", riskClass: "read" }],
      workspaces: ["dev"],
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      maxOutputBytes: 65536,
      maxMessageBytes: 65536
    });
    const adapter = createStdioAdapter(manifest);
    await adapter.start();
    const tools = await adapter.listTools();
    expect(tools.map((t) => t.canonicalId)).toContain("mock.echo");
    const result = await adapter.callTool("mock.echo", {}, {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe("pong");
    await adapter.stop();
  });

  it("passes only allowlisted environment variables to the child", async () => {
    const dir = await makeTempDir();
    const provider = await writeMockProvider(dir, "echo_env");
    const manifest = await compileExtensionManifest({
      id: "mock",
      transport: "stdio",
      version: "1.0.0",
      command: process.execPath,
      args: [provider],
      tools: [{ canonicalId: "mock.echo", riskClass: "read" }],
      workspaces: ["dev"],
      envAllowlist: ["MOCK_TOKEN"],
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000
    });
    process.env.MOCK_TOKEN = "SECRET_VALUE";
    try {
      const adapter = createStdioAdapter(manifest);
      await adapter.start();
      const result = await adapter.callTool("mock.echo", {}, {});
      expect(result.text).toBe("env=SECRET_VALUE");
      await adapter.stop();
    } finally {
      delete process.env.MOCK_TOKEN;
    }
  });
});
