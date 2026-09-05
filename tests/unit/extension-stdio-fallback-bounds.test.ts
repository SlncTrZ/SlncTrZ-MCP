import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileExtensionManifest,
  type ExtensionManifestV1
} from "../../src/extension/manifest.js";
import { createStdioAdapter } from "../../src/extension/stdio-adapter.js";
import { createExtensionSupervisor } from "../../src/extension/supervisor.js";
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
): Promise<{
  script: string;
  probePidFile: string;
  legacyPidFile: string;
  spawnPrefix: string;
}> {
  const script = join(root, `${mode}.cjs`);
  const probePidFile = join(root, `${mode}.probe.pid`);
  const legacyPidFile = join(root, `${mode}.legacy.pid`);
  const spawnPrefix = `${mode}.spawn.`;
  const discoverBranch =
    mode === "silent-discover"
      ? `if (request.method === 'server/discover') { writeFileSync(${JSON.stringify(probePidFile)}, String(process.pid)); continue; }`
      : mode === "exit-discover"
        ? `if (request.method === 'server/discover') { writeFileSync(${JSON.stringify(probePidFile)}, String(process.pid)); process.exit(0); }`
        : `if (request.method === 'server/discover') { writeFileSync(${JSON.stringify(probePidFile)}, String(process.pid)); reply({ error: { code: -32601, message: 'method not found' } }); continue; }`;
  await writeFile(
    script,
    [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(join(root, `${mode}.spawn.`))} + String(process.pid), '');`,
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
      `    if (request.method === 'initialize') { writeFileSync(${JSON.stringify(legacyPidFile)}, String(process.pid)); reply({ result: { protocolVersion: '2025-11-25' } }); continue; }`,
      "    if (request.method === 'tools/list') { reply({ result: { tools: [{ name: 'echo' }] } }); continue; }",
      "    if (request.method === 'tools/call') { reply({ result: { content: [{ type: 'text', text: 'pong' }] } }); }",
      "  }",
      "});"
    ].join("\n"),
    "utf8"
  );
  return { script, probePidFile, legacyPidFile, spawnPrefix };
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
        const startupTimeoutMs = 1_800;
        const manifest = await compileExtensionManifest(
          manifestFor(fixture.script, "legacy", startupTimeoutMs)
        );
        adapter = createStdioAdapter(manifest);
        const startedAt = Date.now();
        await adapter.start();
        expect((await adapter.listTools()).map((tool) => tool.canonicalId)).toEqual(["echo"]);
        expect(Date.now() - startedAt).toBeLessThan(startupTimeoutMs + 500);

        const legacyPid = Number(await readFile(fixture.legacyPidFile, "utf8"));
        const generationPids = (await readdir(root))
          .filter((entry) => entry.startsWith(fixture.spawnPrefix))
          .map((entry) => Number(entry.slice(fixture.spawnPrefix.length)))
          .filter((pid) => Number.isInteger(pid) && pid > 0);
        expect(generationPids).toContain(legacyPid);
        expect(generationPids.some((pid) => pid !== legacyPid)).toBe(true);
        await Promise.all(
          generationPids.filter((pid) => pid !== legacyPid).map((pid) => waitGone(pid))
        );
        await adapter.stop();
        adapter = undefined;
        await expect(waitGone(legacyPid)).resolves.toBeUndefined();
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
      const silentSpawnPrefix = "silent.spawn.";
      await writeFile(
        silentScript,
        [
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(join(root, "silent.spawn."))} + String(process.pid), '');`,
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

      const silentStartupTimeoutMs = 1_500;
      const firstStartedAt = Date.now();
      const first = await orchestrator.add({
        manifest: manifestFor(silentScript, "silent", silentStartupTimeoutMs)
      });
      expect(first.status).toBe("rolled_back");
      expect(Date.now() - firstStartedAt).toBeLessThan(silentStartupTimeoutMs + 500);
      const silentPids = (await readdir(root))
        .filter((entry) => entry.startsWith(silentSpawnPrefix))
        .map((entry) => Number(entry.slice(silentSpawnPrefix.length)))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      expect(silentPids.length).toBeGreaterThan(0);
      await Promise.all(silentPids.map((pid) => waitGone(pid)));

      const second = await orchestrator.add({
        manifest: manifestFor(healthy.script, "healthy", 1_800)
      });
      expect(second.status).toBe("committed");
      expect((await store.list()).map((provider) => provider.id)).toEqual(["healthy"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture did not reach discovery");
}

describe("stdio explicit stop during discovery", () => {
  for (const supervised of [false, true]) {
    it(`does not start fallback after ${supervised ? "supervisor" : "adapter"} stop`, async () => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-stdio-stop-"));
      let adapter: ReturnType<typeof createStdioAdapter> | undefined;
      let adapterStarting: Promise<unknown> | undefined;
      try {
        const fixture = await legacyFixture(root, "silent-discover");
        adapter = createStdioAdapter(
          await compileExtensionManifest(manifestFor(fixture.script, "legacy", 9_000))
        );
        const current = adapter;
        const observedAdapter = {
          ...current,
          start() {
            const pending = current.start();
            adapterStarting = pending.then(
              () => ({ started: true }),
              (error: unknown) => error
            );
            return pending;
          }
        };
        const owner = supervised
          ? createExtensionSupervisor({ adapter: observedAdapter, startupTimeoutMs: 9_000 })
          : observedAdapter;
        const starting = owner.start().then(
          () => ({ started: true }),
          (error: unknown) => error
        );
        const probePid = await waitForPid(fixture.probePidFile);

        await owner.stop();
        expect(await starting).toMatchObject({ code: "provider_unavailable" });
        expect(await adapterStarting).toMatchObject({ code: "provider_unavailable" });
        expect(owner.health()).toBe("unavailable");
        expect(current.health()).toBe("unavailable");
        await expect(current.listTools()).rejects.toMatchObject({ code: "provider_unavailable" });
        const spawned = (await readdir(root)).filter((entry) =>
          entry.startsWith(fixture.spawnPrefix)
        );
        expect(spawned).toEqual([`${fixture.spawnPrefix}${probePid}`]);
        await expect(waitGone(probePid)).resolves.toBeUndefined();
      } finally {
        await adapter?.stop();
        await adapterStarting;
        await adapter?.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("lets an explicit restart own its lifecycle before the cancelled start settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-stdio-stop-restart-"));
    let adapter: ReturnType<typeof createStdioAdapter> | undefined;
    let starting: Promise<unknown> | undefined;
    let restarting: Promise<void> | undefined;
    try {
      const fixture = await legacyFixture(root, "silent-discover");
      adapter = createStdioAdapter(
        await compileExtensionManifest(manifestFor(fixture.script, "legacy", 3_000))
      );
      starting = adapter.start().then(
        () => ({ started: true }),
        (error: unknown) => error
      );
      const oldPid = await waitForPid(fixture.probePidFile);
      const stopping = adapter.stop();
      restarting = adapter.start();
      await stopping;

      expect(await starting).toMatchObject({ code: "provider_unavailable" });
      await restarting;
      expect((await adapter.listTools()).map((tool) => tool.canonicalId)).toEqual(["echo"]);
      expect(adapter.health()).toBe("ready");
      const legacyPid = await waitForPid(fixture.legacyPidFile);
      expect(legacyPid).not.toBe(oldPid);
      const pids = (await readdir(root))
        .filter((entry) => entry.startsWith(fixture.spawnPrefix))
        .map((entry) => Number(entry.slice(fixture.spawnPrefix.length)));
      expect(pids).toHaveLength(3);
      await Promise.all(pids.filter((pid) => pid !== legacyPid).map(waitGone));
      await adapter.stop();
      await expect(waitGone(legacyPid)).resolves.toBeUndefined();
    } finally {
      await adapter?.stop();
      await starting;
      await restarting?.catch(() => undefined);
      await adapter?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
