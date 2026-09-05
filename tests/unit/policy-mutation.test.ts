import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyMutationService } from "../../src/owner/policy-mutation.js";
import type { ReloadResult } from "../../src/policy/policy-store.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function activated(version = "next"): ReloadResult {
  return {
    activated: true,
    previousVersion: "previous",
    activeVersion: version,
    riskIncrease: false,
    result: "activated"
  };
}

function failed(): ReloadResult {
  return {
    activated: false,
    previousVersion: "previous",
    activeVersion: "previous",
    riskIncrease: false,
    result: "failed",
    failureCode: "policy_invalid"
  };
}

async function fixture(authorityMode: "restricted" | "autonomous" = "restricted") {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-policy-mutation-"));
  const pathA = await mkdtemp(join(tmpdir(), "slnctrz-policy-path-a-"));
  const pathB = await mkdtemp(join(tmpdir(), "slnctrz-policy-path-b-"));
  cleanup.push(root, pathA, pathB);
  const policyFile = join(root, "policy.json");
  await writeFile(
    policyFile,
    `${JSON.stringify({ schemaVersion: 2, paths: [pathA], authorityMode }, null, 2)}\n`,
    "utf8"
  );
  return { root, pathA, pathB, policyFile };
}

describe("owner policy mutation", () => {
  it("adds and removes Paths while preserving authorityMode", async () => {
    const { pathA, pathB, policyFile } = await fixture("autonomous");
    const reloads: ReloadResult[] = [];
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          const result = activated(`v${reloads.length + 1}`);
          reloads.push(result);
          return result;
        }
      }
    });

    await service.apply({ kind: "add-path", path: pathB });
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [pathA, pathB],
      authorityMode: "autonomous"
    });

    await service.apply({ kind: "remove-path", path: pathA });
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [pathB],
      authorityMode: "autonomous"
    });
    expect(reloads).toHaveLength(2);
  });

  it("changes authority mode without changing Paths and rolls back on failed reload", async () => {
    const { pathA, policyFile } = await fixture("restricted");
    let shouldActivate = true;
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          return shouldActivate ? activated() : failed();
        }
      }
    });

    await service.apply({ kind: "set-authority-mode", authorityMode: "autonomous" });
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [pathA],
      authorityMode: "autonomous"
    });

    const before = await readFile(policyFile, "utf8");
    shouldActivate = false;
    const result = await service.apply({ kind: "set-authority-mode", authorityMode: "restricted" });
    expect(result.activated).toBe(false);
    expect(await readFile(policyFile, "utf8")).toBe(before);
  });

  it("restores the prior policy when reload rejects the candidate", async () => {
    const { pathA, pathB, policyFile } = await fixture();
    const before = await readFile(policyFile, "utf8");
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          return failed();
        }
      }
    });

    const result = await service.apply({ kind: "add-path", path: pathB });
    expect(result.activated).toBe(false);
    expect(await readFile(policyFile, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(policyFile, "utf8")).paths).toEqual([pathA]);
  });

  it("restores the prior policy when reload throws", async () => {
    const { pathB, policyFile } = await fixture();
    const before = await readFile(policyFile, "utf8");
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          throw new Error("reload_boom");
        }
      }
    });

    await expect(service.apply({ kind: "add-path", path: pathB })).rejects.toThrow("reload_boom");
    expect(await readFile(policyFile, "utf8")).toBe(before);
  });

  it("rejects relative paths and refuses to remove the final Path", async () => {
    const { pathA, policyFile } = await fixture();
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          return activated();
        }
      }
    });

    await expect(service.apply({ kind: "add-path", path: "relative/path" })).rejects.toThrow(
      "path_must_be_absolute"
    );
    await expect(service.apply({ kind: "remove-path", path: pathA })).rejects.toThrow(
      "at_least_one_path_required"
    );
  });

  it("rolls back to the previous activated policy", async () => {
    const { pathA, pathB, policyFile } = await fixture();
    let count = 0;
    const service = createPolicyMutationService({
      policyFile,
      policyStore: {
        async reload() {
          count += 1;
          return activated(`v${count}`);
        }
      }
    });

    await service.apply({ kind: "add-path", path: pathB });
    await service.apply({ kind: "rollback-policy" });
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [pathA],
      authorityMode: "restricted"
    });
  });
});
