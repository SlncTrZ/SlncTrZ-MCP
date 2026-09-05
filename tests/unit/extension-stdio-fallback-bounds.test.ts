import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileExtensionManifest,
  type ExtensionManifestV1
} from "../../src/extension/manifest.js";
import { createStdioAdapter } from "../../src/extension/stdio-adapter.js";
import { createMcpOwnerOrchestrator } from "../../src/owner/mcp-owner-orchestrator.js";
import { createMcpProviderService } from "../../src/owner/mcp-provider-service.js";
import { createMcpProviderStore } from "../../src/owner/mcp-provider-store.js";

async function waitGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process_still_alive:${pid}`);
}

async function legacyFixture(
  root: string,
  mode: "silent-discover" | "exit-discover" | "healthy"
): Promise<{ script: string; pidLog: string }> {
  const script = join(root, `${mode}.cjs`);
  const pidLog = join(root, `${mode}.pids`);
  const discoverBranch =
    mode === "silent-discover"
      ? "if (request.method === 'server/discover') continue;"
      : mode === "exit-discover"
        ? "if (request.method === 'server/discover') process.exit(0);"
        : "if (request.method === 'server/discover') { reply({ error: { code: -32601, message: 'method not found' } }); continue; }";
  await writeFile(
    script,
    [
      "const { appendFileSync } = require('node:fs');",
      `appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + '\\n');`,
      "process.stdin.setEncoding('utf8');",
      "let carry = '';",
      "function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }",
      "process.stdin.on('data', (chunk) => {",
      "  carry += chunk;",
      "  while (carry.includes('\\n')) {",
      "    const index = carry.indexOf('\\n');",
      "    const line = carry.slice(0, index);",
      "    carry = carry.slice(index + 1);",
      "    if (!line) continue;",
      "    const request = JSON.parse(line);",
      "    const reply = (payload) => send({ jsonrpc: '2.0', id: request.id, ...payload });",
      `    ${discoverBranch}`,
      "    if (request.method === 'initialize') { reply({ result: { protocolVersion: '2025-11-25' } }); continue; }",
      "    if (request.method === 'tools/list') { reply({ result: { tools: [{ name: 'echo' }] } }); continue; }",
      "    if (request.method === 'tools/call') { reply({ result: { content: [{ type: 'text', text: 'pong' }] } }); }",
      "  }",
      "});"
    ].join("\n"),
    "utf8"
  );
  return { script, pidLog };
}

function manifestFor(script: string, id = "legacy", startupTimeoutMs = 300): ExtensionManifestV1 {
  return {
    id,
    version: "1.0.0",
    transport: "stdio",
    command: process.execPath,
    args: [script],
    tools: [{ canonicalId: `${id}.echo`, riskClass: "read" }],
    startupTimeoutMs,
    requestTimeoutMs: 500
  };
}

describe("stdio startup fallback bounds", () => {
  for (const mode of ["silent-discover", "exit-discover"] as const) {
    it(`falls back from ${mode} to a fresh legacy generation within the startup budget`, async () => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-stdio-fallback-"));
      let adapter: ReturnType<typeof createStdioAdapter> | undefined;
      try {
        const fixture = await legacyFixture(root, mode);
        const manifest = await compileExtensionManifest(manifestFor(fixture.script));
        adapter = createStdioAdapter(manifest);
        const startedAt = Date.now();
        await adapter.start();
        expect((await adapter.listTools()).map((tool) => tool.canonicalId)).toEqual(["echo"]);
        expect(Date.now() - startedAt).toBeLessThan(800);

        const pids = (await readFile(fixture.pidLog, "utf8")).trim().split(/\r?\n/).map(Number);
        expect(pids.length).toBeGreaterThanOrEqual(2);
        await expect(waitGone(pids[0] ?? 0)).resolves.toBeUndefined();
        await adapter.stop();
        adapter = undefined;
        await Promise.all(pids.slice(1).map((pid) => waitGone(pid)));
      } finally {
        await adapter?.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("times out a fully silent provider, reaps it, and lets the next Owner mutation run", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-stdio-timeout-"));
    try {
      const silentScript = join(root, "silent.cjs");
      const silentPidFile = join(root, "silent.pid");
      await writeFile(
        silentScript,
        [
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(silentPidFile)}, String(process.pid));`,
          "process.stdin.resume();"
        ].join("\n"),
        "utf8"
      );
      const healthy = await legacyFixture(root, "healthy");
      const store = createMcpProviderStore(join(root, "providers.json"));
      const service = createMcpProviderService({
        store,
        isActiveProviderReady: () => true,
        policyStore: {
          async reload() {
            return {
              activated: true,
              previousVersion: "a",
              activeVersion: "b",
              riskIncrease: false,
              result: "activated"
            };
          }
        }
      });
      const orchestrator = createMcpOwnerOrchestrator({
        credentials: {
          async set(ref, credential) {
            return {
              ref,
              kind: credential.kind,
              ...(credential.kind === "env" ? { name: credential.name } : {})
            };
          },
          async remove() {
            return true;
          }
        },
        providers: service
      });

      const firstStartedAt = Date.now();
      const first = await orchestrator.add({
        manifest: manifestFor(silentScript, "silent", 240)
      });
      expect(first.status).toBe("rolled_back");
      expect(Date.now() - firstStartedAt).toBeLessThan(800);
      const silentPid = Number(await readFile(silentPidFile, "utf8"));
      await expect(waitGone(silentPid)).resolves.toBeUndefined();

      const second = await orchestrator.add({
        manifest: manifestFor(healthy.script, "healthy", 500)
      });
      expect(second.status).toBe("committed");
      expect((await store.list()).map((provider) => provider.id)).toEqual(["healthy"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
