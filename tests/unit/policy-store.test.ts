import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyConfigError } from "../../src/policy/policy-config.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import {
  buildActivePolicySnapshot,
  type ActivePolicySnapshot
} from "../../src/policy/policy-snapshot.js";
import {
  createPolicySnapshotStore,
  type PolicySnapshotLoader
} from "../../src/policy/policy-store.js";
import { type ApprovalHook } from "../../src/policy/approval.js";
import { type PolicyAuditSink } from "../../src/observability/policy-audit.js";
import { type KernelCapability } from "../../src/policy/kernel-policy.js";

// Slice 4: a risk-increasing reload defers to an approval hook. These serialization/atomic
// tests change the active root (risk-increasing), so they supply an approving hook to keep
// focusing on store concurrency rather than the approval boundary.
const approveAll: ApprovalHook = async () => "approved";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-store-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function snapshot(readRoot: string, otherRoot?: string): Promise<ActivePolicySnapshot> {
  const compiled = await compilePolicyDocument({
    schemaVersion: 1,
    workspaces: [
      {
        id: "alpha",
        roots: { read: readRoot, ...(otherRoot === undefined ? {} : { write: otherRoot }) },
        profiles: ["read-only"]
      }
    ],
    clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
  });
  return buildActivePolicySnapshot(compiled);
}

describe("policy snapshot store (atomic activation + failed reload retention)", () => {
  it("cannot partially activate a candidate across workspaces", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const store = createPolicySnapshotStore(async () => b, a, { approval: approveAll });
    expect(store.capture()).toBe(a);

    // A candidate load always resolves to one whole frozen snapshot; the store never merges
    // one workspace from the old and one from the new document.
    const result = await store.reload();
    expect(result.activated).toBe(true);
    expect(result.result).toBe("activated");
    const captured = store.capture();
    expect(captured).toBe(b);
    expect(captured.resolve({ clientId: "client-a", scopes: ["mcp:tools"] }, "alpha").version).toBe(
      b.version
    );
  });

  it("retains the exact prior reference and version after an invalid candidate", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const store = createPolicySnapshotStore(async () => {
      throw new PolicyConfigError("policy_file_missing", "Policy file could not be read");
    }, a);
    const prior = store.capture();
    const result = await store.reload();
    expect(result.activated).toBe(false);
    expect(result.previousVersion).toBe(a.version);
    expect(result.activeVersion).toBe(a.version);
    expect(result.failureCode).toBe("policy_file_missing");
    // The store did not mutate or replace the prior object.
    expect(store.capture()).toBe(prior);
  });

  it("surfaces a policy_invalid code for a non-config error", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const store = createPolicySnapshotStore(async () => {
      throw new Error("unexpected");
    }, a);
    const result = await store.reload();
    expect(result.activated).toBe(false);
    expect(result.failureCode).toBe("policy_invalid");
    expect(store.capture()).toBe(a);
  });

  it("serializes a concurrent reload into reload_in_progress without a second load", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));

    let loadCount = 0;
    let release: ((value: ActivePolicySnapshot) => void) | undefined;
    const loader: PolicySnapshotLoader = () => {
      loadCount += 1;
      return new Promise<ActivePolicySnapshot>((resolve) => {
        release = resolve;
      });
    };
    const store = createPolicySnapshotStore(loader, a, { approval: approveAll });

    const first = store.reload();
    // While the first reload is in flight, a second call must not invoke the loader.
    const second = await store.reload();
    expect(second.activated).toBe(false);
    expect(second.failureCode).toBe("reload_in_progress");
    expect(loadCount).toBe(1);

    release?.(b);
    const firstResult = await first;
    expect(firstResult.activated).toBe(true);
    expect(firstResult.activeVersion).toBe(b.version);
    expect(store.capture()).toBe(b);
  });

  it("serializes so a later reload no longer reports in-progress after the first settles", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const c = await snapshot(join(dir, "c"));

    const order: string[] = [];
    const loader: PolicySnapshotLoader = async () => {
      order.push("load");
      return order.length === 1 ? b : c;
    };
    const store = createPolicySnapshotStore(loader, a, { approval: approveAll });

    await store.reload();
    expect(store.capture()).toBe(b);
    const third = await store.reload();
    expect(third.activated).toBe(true);
    expect(third.result).toBe("activated");
    expect(third.activeVersion).toBe(c.version);
    expect(store.capture()).toBe(c);
  });

  it("does not leak a rejection across repeated load failures", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const store = createPolicySnapshotStore(async () => {
      throw new Error("rejected each time");
    }, a);
    for (let i = 0; i < 5; i += 1) {
      const result = await store.reload();
      expect(result.activated).toBe(false);
      expect(result.failureCode).toBe("policy_invalid");
      expect(store.capture()).toBe(a);
    }
  });
});

describe("policy snapshot store: approval boundary (Phase 4 slice 4)", () => {
  it("stages a risk-increasing reload behind the default unavailable hook, retaining the prior snapshot", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const store = createPolicySnapshotStore(async () => b, a);

    const result = await store.reload();
    expect(result.activated).toBe(false);
    expect(result.result).toBe("approval_required");
    expect(result.riskIncrease).toBe(true);
    expect(result.activeVersion).toBe(a.version);
    expect(store.capture()).toBe(a);
  });

  it("activates a risk-increasing reload only when the hook approves", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const approve: ApprovalHook = async () => "approved";
    const store = createPolicySnapshotStore(async () => b, a, { approval: approve });

    const result = await store.reload();
    expect(result.activated).toBe(true);
    expect(result.result).toBe("activated");
    expect(result.riskIncrease).toBe(true);
    expect(store.capture()).toBe(b);
  });

  it("retains the prior snapshot when the hook rejects", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const reject: ApprovalHook = async () => "rejected";
    const store = createPolicySnapshotStore(async () => b, a, { approval: reject });

    const result = await store.reload();
    expect(result.activated).toBe(false);
    expect(result.result).toBe("rejected");
    expect(result.activeVersion).toBe(a.version);
    expect(store.capture()).toBe(a);
  });

  it("activates an access reduction without any approval hook", async () => {
    const dir = await makeTempDir();
    // Same read-only workspace, but the candidate narrows the read root to a child of the prior
    // root. This is an access reduction (candidate is contained in previous), not an increase.
    const a = await snapshot(dir);
    const b = await snapshot(join(dir, "narrow"));
    const store = createPolicySnapshotStore(async () => b, a);

    const result = await store.reload();
    expect(result.riskIncrease).toBe(false);
    expect(result.activated).toBe(true);
    expect(result.result).toBe("activated");
    expect(store.capture()).toBe(b);
  });

  it("audits exactly once per reload with a secret-free event", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const events: Record<string, unknown>[] = [];
    const audit: PolicyAuditSink = (event) => events.push({ ...event });
    const store = createPolicySnapshotStore(async () => b, a, { audit });

    const result = await store.reload();
    expect(result.result).toBe("approval_required");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "policy_reload",
      actorKind: "internal_reload",
      result: "approval_required",
      riskIncrease: true
    });
    const line = JSON.stringify(events[0] ?? {});
    expect(line).not.toContain(join(dir, "a"));
    expect(line).not.toContain("client-a");
  });

  it("does not let an audit sink failure undo a completed activation", async () => {
    const dir = await makeTempDir();
    const a = await snapshot(join(dir, "a"));
    const b = await snapshot(join(dir, "b"));
    const approve: ApprovalHook = async () => "approved";
    const audit: PolicyAuditSink = () => {
      throw new Error("audit sink down");
    };
    const store = createPolicySnapshotStore(async () => b, a, { approval: approve, audit });

    const result = await store.reload();
    expect(result.activated).toBe(true);
    expect(store.capture()).toBe(b);
  });
});

describe("escalation vectors: prior snapshot retained + secret-free audit (Phase 4 fix)", () => {
  async function buildSnapshot(config: {
    readonly workspaces: readonly {
      id: string;
      roots: { read?: string; write?: string; exec?: string };
      profiles: ("read-only" | "minimal" | "custom")[];
      customCapabilities?: KernelCapability[];
      exec?: { commandsFile: string; path?: string };
    }[];
    readonly bindings?: readonly { clientId: string; workspaceIds: string[] }[];
  }): Promise<ActivePolicySnapshot> {
    return buildActivePolicySnapshot(await compilePolicyDocument({ schemaVersion: 1, ...config }));
  }

  it("binding A->B (same length) returns approval_required and retains the exact prior snapshot", async () => {
    const prior = await buildSnapshot({
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "b", roots: { read: "/home/b" }, profiles: ["read-only"] }
      ],
      bindings: [{ clientId: "client-1", workspaceIds: ["a", "b"] }]
    });
    const candidate = await buildSnapshot({
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "c", roots: { read: "/home/c" }, profiles: ["read-only"] }
      ],
      bindings: [{ clientId: "client-1", workspaceIds: ["a", "c"] }]
    });
    const events: Record<string, unknown>[] = [];
    const store = createPolicySnapshotStore(async () => candidate, prior, {
      audit: (event) => events.push({ ...event })
    });
    const result = await store.reload();
    expect(result.activated).toBe(false);
    expect(result.result).toBe("approval_required");
    expect(result.riskIncrease).toBe(true);
    // Exact prior reference/version retained.
    expect(store.capture()).toBe(prior);
    expect(store.capture().version).toBe(prior.version);
    // Audit is secret-free.
    const line = JSON.stringify(events[0] ?? {});
    expect(line).not.toContain("/home");
    expect(line).not.toContain("client-1");
    expect(events).toHaveLength(1);
  });

  it("adding a profile returns approval_required and retains the exact prior snapshot", async () => {
    const prior = await buildSnapshot({
      workspaces: [
        { id: "a", roots: { read: "/home/a", write: "/home/w" }, profiles: ["read-only"] }
      ]
    });
    const candidate = await buildSnapshot({
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["read-only", "minimal"]
        }
      ]
    });
    const events: Record<string, unknown>[] = [];
    const store = createPolicySnapshotStore(async () => candidate, prior, {
      audit: (event) => events.push({ ...event })
    });
    const result = await store.reload();
    expect(result.result).toBe("approval_required");
    expect(store.capture()).toBe(prior);
    expect(JSON.stringify(events[0] ?? {})).not.toContain("/home");
  });

  it.skipIf(process.platform === "win32")(
    "changing a command definition returns approval_required and retains the prior snapshot",
    async () => {
      const dir = await makeTempDir();
      const rootReal = await realpath(dir);
      const scriptA = join(rootReal, "a.sh");
      const scriptB = join(rootReal, "b.sh");
      await writeFile(scriptA, "#!/bin/sh\necho a\n", { mode: 0o755 });
      await writeFile(scriptB, "#!/bin/sh\necho b\n", { mode: 0o755 });
      const writeCommands = async (binaryPath: string): Promise<string> => {
        const file = join(rootReal, `cmds-${binaryPath.endsWith("a.sh") ? "a" : "b"}.json`);
        await writeFile(
          file,
          JSON.stringify([
            {
              commandId: "tool",
              binaryPath,
              fixedArgs: [],
              allowExtraArgs: false,
              maxExtraArgs: 0,
              cwdMode: "fixed",
              fixedEnv: {},
              allowStdin: false,
              commandClass: "inspect"
            }
          ]),
          "utf8"
        );
        return file;
      };
      const prior = await buildSnapshot({
        workspaces: [
          {
            id: "w",
            roots: { read: "/home/r", exec: rootReal },
            profiles: ["minimal"],
            exec: { commandsFile: await writeCommands(scriptA), path: "/usr/bin" }
          }
        ]
      });
      const candidate = await buildSnapshot({
        workspaces: [
          {
            id: "w",
            roots: { read: "/home/r", exec: rootReal },
            profiles: ["minimal"],
            exec: { commandsFile: await writeCommands(scriptB), path: "/usr/bin" }
          }
        ]
      });
      const events: Record<string, unknown>[] = [];
      const store = createPolicySnapshotStore(async () => candidate, prior, {
        audit: (event) => events.push({ ...event })
      });
      const result = await store.reload();
      expect(result.result).toBe("approval_required");
      expect(store.capture()).toBe(prior);
      expect(JSON.stringify(events[0] ?? {})).not.toContain("a.sh");
      expect(JSON.stringify(events[0] ?? {})).not.toContain("b.sh");
    }
  );

  it("expanding customCapabilities returns approval_required and retains the prior snapshot", async () => {
    const prior = await buildSnapshot({
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["custom"],
          customCapabilities: ["core.read"]
        }
      ]
    });
    const candidate = await buildSnapshot({
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["custom"],
          customCapabilities: ["core.read", "core.write"]
        }
      ]
    });
    const events: Record<string, unknown>[] = [];
    const store = createPolicySnapshotStore(async () => candidate, prior, {
      audit: (event) => events.push({ ...event })
    });
    const result = await store.reload();
    expect(result.result).toBe("approval_required");
    expect(result.riskIncrease).toBe(true);
    expect(store.capture()).toBe(prior);
    expect(JSON.stringify(events[0] ?? {})).not.toContain("/home");
  });
});
