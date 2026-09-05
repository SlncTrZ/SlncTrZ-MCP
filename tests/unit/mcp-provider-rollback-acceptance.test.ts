import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionManifestV1 } from "../../src/extension/manifest.js";
import { createMcpCredentialStore } from "../../src/owner/mcp-credential-store.js";
import { createMcpOwnerOrchestrator } from "../../src/owner/mcp-owner-orchestrator.js";
import { createMcpProviderService } from "../../src/owner/mcp-provider-service.js";
import { createMcpProviderStore } from "../../src/owner/mcp-provider-store.js";
import type { ReloadResult } from "../../src/policy/policy-store.js";

const manifest: ExtensionManifestV1 = {
  id: "demo",
  version: "1",
  transport: "stdio",
  command: process.execPath,
  tools: [{ canonicalId: "demo.echo", riskClass: "read" }],
  credentialRefs: ["old-credential"]
};
const rejected: ReloadResult = {
  activated: false,
  previousVersion: "old",
  activeVersion: "old",
  riskIncrease: false,
  result: "failed",
  failureCode: "policy_invalid"
};
const discovery = async () => ({
  providerId: "demo",
  declaredTools: ["demo.echo"],
  discoveredTools: ["demo.echo"],
  matchesDeclaration: true
});

describe("provider rollback durable credential acceptance", () => {
  for (const operation of ["update-auth", "replace", "new"] as const) {
    for (const reloadThrows of [false, true]) {
      for (const restoreFails of [false, true]) {
        it(`${operation}: reload ${reloadThrows ? "throw" : "false"}, restore ${restoreFails ? "fails" : "succeeds"} preserves usable references`, async () => {
          const root = await mkdtemp(join(tmpdir(), "slnctrz-rollback-acceptance-"));
          try {
            const credentials = createMcpCredentialStore(join(root, "credentials"));
            const disk = createMcpProviderStore(join(root, "providers.json"));
            await credentials.set("old-credential", { kind: "bearer", value: "OLD" });
            await disk.upsert({
              manifest: {
                ...manifest,
                id: "shared",
                tools: [{ canonicalId: "shared.echo", riskClass: "read" }]
              }
            });
            if (operation !== "new") await disk.upsert({ manifest });
            let stagedRef: string | undefined;
            const faultStore = {
              ...disk,
              async upsert(input: Parameters<typeof disk.upsert>[0]) {
                if (input.manifest.id === "demo") {
                  const ref = input.manifest.credentialRefs?.[0];
                  if (stagedRef !== undefined && ref === "old-credential" && restoreFails) {
                    throw Object.assign(new Error("fixture restore failed"), { code: "EIO" });
                  }
                  if (ref !== "old-credential") stagedRef = ref;
                }
                return disk.upsert(input);
              },
              async remove(id: string) {
                if (id === "demo" && stagedRef !== undefined && restoreFails) {
                  throw Object.assign(new Error("fixture remove failed"), { code: "EIO" });
                }
                return disk.remove(id);
              }
            };
            const service = createMcpProviderService({
              store: faultStore,
              isActiveProviderReady: () => true,
              policyStore: {
                async reload() {
                  if (reloadThrows) throw new Error("fixture reload failed");
                  return rejected;
                }
              }
            });
            const orchestrator = createMcpOwnerOrchestrator({
              credentials,
              providers: { ...service, discoverCandidate: discovery }
            });
            const auth = { kind: "bearer", value: "NEW" } as const;
            const result =
              operation === "update-auth"
                ? await orchestrator.updateAuth({ providerId: "demo", auth })
                : await orchestrator.add({ manifest, auth });
            expect(stagedRef).toBeDefined();
            if (stagedRef === undefined) throw new Error("candidate was not written");
            expect((await credentials.resolve(["old-credential"]))[0]?.value).toBe("OLD");
            expect((await disk.get("shared"))?.manifest.credentialRefs).toEqual(["old-credential"]);
            const current = await disk.get("demo");
            if (restoreFails) {
              expect(result).toMatchObject({
                status: "partial_failure",
                failedStep: "mcp_provider_rollback_failed",
                recovery: { safeToRetry: false }
              });
              expect(current?.manifest.credentialRefs).toEqual([stagedRef]);
              expect((await credentials.resolve([stagedRef]))[0]?.value).toBe("NEW");
            } else {
              expect(result).toMatchObject({
                status: "rolled_back",
                recovery: { safeToRetry: true }
              });
              if (operation === "new") expect(current).toBeUndefined();
              else expect(current?.manifest.credentialRefs).toEqual(["old-credential"]);
              await expect(credentials.resolve([stagedRef])).rejects.toThrow();
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  }

  for (const recoveryThrows of [false, true]) {
    it(`keeps credentials referenced by an unavailable active candidate when recovery reload ${recoveryThrows ? "throws" : "rejects"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-active-recovery-"));
      try {
        const credentials = createMcpCredentialStore(join(root, "credentials"));
        const disk = createMcpProviderStore(join(root, "providers.json"));
        await credentials.set("old-credential", { kind: "bearer", value: "OLD" });
        await disk.upsert({ manifest });
        let activeRef = "old-credential";
        let reloadCount = 0;
        const service = createMcpProviderService({
          store: disk,
          isActiveProviderReady: () => false,
          policyStore: {
            async reload() {
              reloadCount += 1;
              if (reloadCount === 1) {
                const ref = (await disk.get("demo"))?.manifest.credentialRefs?.[0];
                if (ref === undefined) throw new Error("candidate reference missing");
                activeRef = ref;
                return {
                  activated: true,
                  previousVersion: "old",
                  activeVersion: "candidate",
                  riskIncrease: false,
                  result: "activated"
                };
              }
              if (recoveryThrows) throw new Error("fixture recovery reload failed");
              return { ...rejected, previousVersion: "candidate", activeVersion: "candidate" };
            }
          }
        });
        const orchestrator = createMcpOwnerOrchestrator({
          credentials,
          providers: { ...service, discoverCandidate: discovery }
        });
        const result = await orchestrator.updateAuth({
          providerId: "demo",
          auth: { kind: "bearer", value: "NEW" }
        });
        expect(result).toMatchObject({
          status: "partial_failure",
          recovery: { safeToRetry: false }
        });
        expect(reloadCount).toBe(2);
        expect((await disk.get("demo"))?.manifest.credentialRefs).toEqual(["old-credential"]);
        expect(activeRef).not.toBe("old-credential");
        expect((await credentials.resolve([activeRef]))[0]?.value).toBe("NEW");
        expect((await credentials.resolve(["old-credential"]))[0]?.value).toBe("OLD");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("commits a disabled provider credential update without requiring runtime readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-disabled-acceptance-"));
    try {
      const credentials = createMcpCredentialStore(join(root, "credentials"));
      const disk = createMcpProviderStore(join(root, "providers.json"));
      await credentials.set("old-credential", { kind: "bearer", value: "OLD" });
      await disk.upsert({ manifest, enabled: false });
      const readiness = vi.fn(() => false);
      const service = createMcpProviderService({
        store: disk,
        isActiveProviderReady: readiness,
        policyStore: {
          async reload() {
            return {
              activated: true,
              previousVersion: "old",
              activeVersion: "new",
              riskIncrease: false,
              result: "activated"
            };
          }
        }
      });
      const result = await createMcpOwnerOrchestrator({
        credentials,
        providers: { ...service, discoverCandidate: discovery }
      }).updateAuth({ providerId: "demo", auth: { kind: "bearer", value: "NEW" } });
      expect(result.status).toBe("committed");
      expect(readiness).not.toHaveBeenCalled();
      const current = await disk.get("demo");
      expect(current?.enabled).toBe(false);
      expect((await credentials.resolve(current?.manifest.credentialRefs ?? []))[0]?.value).toBe(
        "NEW"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
