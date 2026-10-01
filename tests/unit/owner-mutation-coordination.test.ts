import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPolicyMutationService } from "../../src/owner/policy-mutation.js";
import { createMcpProviderService } from "../../src/owner/mcp-provider-service.js";
import { createMcpProviderStore } from "../../src/owner/mcp-provider-store.js";
import { compilePolicyDocument, loadPolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { createPolicySnapshotStore } from "../../src/policy/policy-store.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Owner mutations share the policy activation boundary", () => {
  it.each([false, true])(
    "queues provider persistence behind policy reload; candidate rejected=%s",
    async (rejectProvider) => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-coordination-"));
      const entered = gate();
      const release = gate();
      const pending: Promise<unknown>[] = [];
      try {
        const policyFile = join(root, "policy.json");
        await writeFile(
          policyFile,
          JSON.stringify({ schemaVersion: 2, paths: [root], authorityMode: "restricted" })
        );
        const providers = createMcpProviderStore(join(root, "providers.json"));
        const get = vi.fn(providers.get);
        const upsert = vi.fn(providers.upsert);
        const initial = buildActivePolicySnapshot(
          await compilePolicyDocument(await loadPolicyDocument(policyFile))
        );
        let loads = 0;
        const policyStore = createPolicySnapshotStore(async () => {
          loads += 1;
          const document = await loadPolicyDocument(policyFile);
          if (loads === 1) {
            entered.resolve();
            await release.promise;
          }
          const records = await providers.list();
          if (rejectProvider && records.length > 0) throw new Error("candidate rejected");
          return buildActivePolicySnapshot(
            await compilePolicyDocument(
              document,
              undefined,
              records.map((record) => record.manifest)
            )
          );
        }, initial);
        const policy = createPolicyMutationService({ policyFile, policyStore });
        const provider = createMcpProviderService({
          store: { ...providers, get, upsert },
          policyStore,
          isActiveProviderReady: () => true
        });
        const policyChange = policy.apply({
          kind: "set-authority-mode",
          authorityMode: "autonomous"
        });
        pending.push(policyChange);
        await entered.promise;
        const providerChange = provider.addOrUpdate({
          manifest: {
            id: "probe",
            version: "1",
            transport: "streamable-http",
            endpoint: "https://provider.example.test/mcp",
            tools: [{ canonicalId: "probe.ping", riskClass: "read" }]
          }
        });
        pending.push(providerChange);
        await new Promise<void>((done) => setImmediate(done));
        const touchedCandidateDuringReload =
          get.mock.calls.length > 0 || upsert.mock.calls.length > 0;
        const externalReload = await policyStore.reload();
        release.resolve();
        const [policyResult, providerResult] = await Promise.all([policyChange, providerChange]);
        expect(touchedCandidateDuringReload).toBe(false);
        expect(externalReload).toMatchObject({
          activated: false,
          failureCode: "reload_in_progress"
        });
        expect(policyResult.activated).toBe(true);
        expect(providerResult.reload.activated).toBe(!rejectProvider);
        const persisted = (await providers.list()).map((record) => record.id);
        const active = policyStore
          .capture()
          .normalized.extensionRegistry.extensions.map((record) => record.id);
        expect(persisted).toEqual(rejectProvider ? [] : ["probe"]);
        expect(active).toEqual(persisted);
        expect(JSON.parse(await readFile(policyFile, "utf8")).authorityMode).toBe("autonomous");
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("waits for an already-running reload before publishing a policy candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-reload-"));
    const entered = gate(),
      release = gate();
    const pending: Promise<unknown>[] = [];
    try {
      const policyFile = join(root, "policy.json");
      const before = JSON.stringify({
        schemaVersion: 2,
        paths: [root],
        authorityMode: "restricted"
      });
      await writeFile(policyFile, before);
      const initial = buildActivePolicySnapshot(
        await compilePolicyDocument(await loadPolicyDocument(policyFile))
      );
      let loads = 0;
      const store = createPolicySnapshotStore(async () => {
        if (++loads === 1) {
          entered.resolve();
          await release.promise;
        }
        return buildActivePolicySnapshot(
          await compilePolicyDocument(await loadPolicyDocument(policyFile))
        );
      }, initial);
      const reload = store.reload();
      pending.push(reload);
      await entered.promise;
      const change = createPolicyMutationService({ policyFile, policyStore: store }).apply({
        kind: "set-authority-mode",
        authorityMode: "autonomous"
      });
      pending.push(change);
      await new Promise<void>((done) => setImmediate(done));
      const bytesDuringReload = await readFile(policyFile, "utf8");
      release.resolve();
      await reload;
      expect((await change).activated).toBe(true);
      expect(bytesDuringReload).toBe(before);
      expect(JSON.parse(await readFile(policyFile, "utf8")).authorityMode).toBe("autonomous");
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps readiness recovery inside the transaction and admits the next mutation after rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-recovery-"));
    try {
      const policyFile = join(root, "policy.json");
      await writeFile(
        policyFile,
        JSON.stringify({ schemaVersion: 2, paths: [root], authorityMode: "restricted" })
      );
      const providers = createMcpProviderStore(join(root, "providers.json"));
      const initial = buildActivePolicySnapshot(
        await compilePolicyDocument(await loadPolicyDocument(policyFile))
      );
      let loads = 0;
      const store = createPolicySnapshotStore(async () => {
        loads += 1;
        const records = await providers.list();
        return buildActivePolicySnapshot(
          await compilePolicyDocument(
            await loadPolicyDocument(policyFile),
            undefined,
            records.map((record) => record.manifest)
          )
        );
      }, initial);
      const provider = createMcpProviderService({
        store: providers,
        policyStore: store,
        isActiveProviderReady: () => false
      });
      const failed = provider.addOrUpdate({
        manifest: {
          id: "probe",
          version: "1",
          transport: "streamable-http",
          endpoint: "https://provider.example.test/mcp",
          tools: [{ canonicalId: "probe.ping", riskClass: "read" }]
        }
      });
      const outcome = failed.then(
        () => "unexpected success",
        (error) => error
      );
      const next = createPolicyMutationService({ policyFile, policyStore: store }).apply({
        kind: "set-authority-mode",
        authorityMode: "autonomous"
      });
      expect(await outcome).toMatchObject({
        code: "mcp_provider_activation_unavailable",
        rollbackComplete: true
      });
      expect((await next).activated).toBe(true);
      expect(loads).toBe(3);
      expect(await providers.list()).toEqual([]);
      expect(store.capture().normalized.extensionRegistry.extensions).toEqual([]);
      expect(JSON.parse(await readFile(policyFile, "utf8")).authorityMode).toBe("autonomous");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
