import { describe, expect, it } from "vitest";
import { compilePolicyDocument, PolicyConfigError } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { createPolicySnapshotStore } from "../../src/policy/policy-store.js";

async function snapshot(path: string) {
  return buildActivePolicySnapshot(
    await compilePolicyDocument({ schemaVersion: 2, paths: [path] })
  );
}

describe("atomic policy store", () => {
  it("activates a fully built candidate directly without approval ceremony", async () => {
    const first = await snapshot("/tmp/a");
    const second = await snapshot("/tmp/b");
    const store = createPolicySnapshotStore(async () => second, first);
    expect(await store.reload()).toMatchObject({
      activated: true,
      result: "activated",
      riskIncrease: false
    });
    expect(store.capture()).toBe(second);
  });

  it("notifies activation observers with prior and active generations", async () => {
    const first = await snapshot("/tmp/a");
    const second = await snapshot("/tmp/b");
    const activated: [string, string][] = [];
    const store = createPolicySnapshotStore(async () => second, first, {
      onActivated: (previous, active) => {
        activated.push([previous.version, active.version]);
      }
    });
    await store.reload();
    expect(activated).toEqual([[first.version, second.version]]);
  });

  it("does not notify activation observers when candidate loading fails", async () => {
    const first = await snapshot("/tmp/a");
    let activated = false;
    const store = createPolicySnapshotStore(
      async () => {
        throw new PolicyConfigError("policy_invalid", "bad candidate");
      },
      first,
      { onActivated: () => (activated = true) }
    );
    await store.reload();
    expect(activated).toBe(false);
  });

  it("retains the prior generation when candidate loading fails", async () => {
    const first = await snapshot("/tmp/a");
    const store = createPolicySnapshotStore(async () => {
      throw new PolicyConfigError("policy_invalid", "bad candidate");
    }, first);
    expect(await store.reload()).toMatchObject({
      activated: false,
      result: "failed",
      failureCode: "policy_invalid"
    });
    expect(store.capture()).toBe(first);
  });
});
