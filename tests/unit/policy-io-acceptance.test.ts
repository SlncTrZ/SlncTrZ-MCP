import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyMutationService } from "../../src/owner/policy-mutation.js";
import { compilePolicyDocument, loadPolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { createPolicySnapshotStore } from "../../src/policy/policy-store.js";
import type { ReloadResult } from "../../src/policy/policy-store.js";

const faults = vi.hoisted(() => ({
  rejectRename: undefined as ((destination: string) => boolean) | undefined
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async rename(
      source: Parameters<typeof actual.rename>[0],
      target: Parameters<typeof actual.rename>[1]
    ) {
      if (faults.rejectRename?.(String(target))) {
        throw Object.assign(new Error("fixture rename failed"), { code: "EIO" });
      }
      return actual.rename(source, target);
    }
  };
});
afterEach(() => {
  faults.rejectRename = undefined;
});

const rejected: ReloadResult = {
  activated: false,
  previousVersion: "old",
  activeVersion: "old",
  riskIncrease: false,
  result: "failed",
  failureCode: "policy_invalid"
};

async function fixture(previousExists: boolean) {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-policy-io-acceptance-"));
  const policyFile = join(root, "policy.json");
  const previousFile = policyFile + ".previous";
  const prior =
    JSON.stringify({ schemaVersion: 2, paths: [root], authorityMode: "restricted" }) + "\n";
  const previous =
    JSON.stringify({ schemaVersion: 2, paths: [root], authorityMode: "autonomous" }) + "\n";
  await writeFile(policyFile, prior);
  if (previousExists) await writeFile(previousFile, previous);
  const loader = async () =>
    buildActivePolicySnapshot(await compilePolicyDocument(await loadPolicyDocument(policyFile)));
  const initial = await loader();
  const policyStore = createPolicySnapshotStore(loader, initial);
  return { root, policyFile, previousFile, prior, previous, loader, initial, policyStore };
}

describe("policy durable and active I/O acceptance", () => {
  for (const operation of ["mutation", "rollback"] as const) {
    it(`${operation}: a backup rename failure leaves disk, previous and active state unchanged`, async () => {
      const f = await fixture(true);
      try {
        faults.rejectRename = (destination) => destination === f.previousFile;
        const service = createPolicyMutationService({
          policyFile: f.policyFile,
          policyStore: f.policyStore
        });
        await expect(
          service.apply(
            operation === "rollback"
              ? { kind: "rollback-policy" }
              : { kind: "set-authority-mode", authorityMode: "autonomous" }
          )
        ).rejects.toMatchObject({ code: "EIO" });
        expect(await readFile(f.policyFile, "utf8")).toBe(f.prior);
        expect(await readFile(f.previousFile, "utf8")).toBe(f.previous);
        expect(f.policyStore.capture()).toBe(f.initial);
        expect((await f.loader()).version).toBe(f.initial.version);
      } finally {
        faults.rejectRename = undefined;
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }

  for (const previousExists of [false, true]) {
    for (const reloadThrows of [false, true]) {
      it(`restores policy and previous ${previousExists ? "bytes" : "absence"} after reload ${reloadThrows ? "throw" : "false"}`, async () => {
        const f = await fixture(previousExists);
        try {
          const service = createPolicyMutationService({
            policyFile: f.policyFile,
            policyStore: {
              async reload() {
                if (reloadThrows) throw new Error("fixture reload failed");
                return rejected;
              }
            }
          });
          const result = service.apply({ kind: "set-authority-mode", authorityMode: "autonomous" });
          if (reloadThrows) await expect(result).rejects.toThrow("fixture reload failed");
          else expect((await result).activated).toBe(false);
          expect(await readFile(f.policyFile, "utf8")).toBe(f.prior);
          if (previousExists) expect(await readFile(f.previousFile, "utf8")).toBe(f.previous);
          else
            await expect(readFile(f.previousFile, "utf8")).rejects.toMatchObject({
              code: "ENOENT"
            });
          expect((await f.loader()).version).toBe(f.policyStore.capture().version);
        } finally {
          await rm(f.root, { recursive: true, force: true });
        }
      });
    }
  }

  for (const failedTarget of ["policy", "previous"] as const) {
    for (const reloadThrows of [false, true]) {
      it(`reports explicit recovery failure when ${failedTarget} cannot be restored after reload ${reloadThrows ? "throw" : "false"}`, async () => {
        const f = await fixture(true);
        try {
          const service = createPolicyMutationService({
            policyFile: f.policyFile,
            policyStore: {
              async reload() {
                faults.rejectRename = (destination) =>
                  destination === (failedTarget === "policy" ? f.policyFile : f.previousFile);
                if (reloadThrows) throw new Error("fixture reload failed");
                return rejected;
              }
            }
          });
          await expect(
            service.apply({
              kind: "set-authority-mode",
              authorityMode: "autonomous"
            })
          ).rejects.toMatchObject({ code: "policy_recovery_failed" });
          expect(f.policyStore.capture()).toBe(f.initial);
          const disk = JSON.parse(await readFile(f.policyFile, "utf8")) as {
            authorityMode: string;
          };
          expect(disk.authorityMode).toBe(failedTarget === "policy" ? "autonomous" : "restricted");
          expect(await readFile(f.previousFile, "utf8")).toBe(f.prior);
        } finally {
          faults.rejectRename = undefined;
          await rm(f.root, { recursive: true, force: true });
        }
      });
    }
  }
});
