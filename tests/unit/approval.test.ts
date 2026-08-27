import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalDecision,
  type ApprovalHook,
  type PolicyChangeSummary,
  classifyPolicyRisk,
  defaultApprovalHook,
  buildPolicyChangeSummary
} from "../../src/policy/approval.js";
import { compilePolicyDocument, type CompiledPolicyInput } from "../../src/policy/policy-config.js";
import {
  buildActivePolicySnapshot,
  type ActivePolicySnapshot
} from "../../src/policy/policy-snapshot.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-approval-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

interface ExecFixture {
  readonly root: string;
  readonly commandsFile: string;
}

async function makeExecFixture(): Promise<ExecFixture> {
  const dir = await makeTempDir();
  const rootReal = await realpath(dir);
  const script = join(rootReal, "echo.sh");
  await writeFile(script, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  const binaryReal = await realpath(script);
  const commandsFile = join(rootReal, "commands.json");
  await writeFile(
    commandsFile,
    JSON.stringify([
      {
        commandId: "show-version",
        binaryPath: binaryReal,
        fixedArgs: ["--version"],
        allowExtraArgs: false,
        maxExtraArgs: 0,
        cwdMode: "fixed",
        fixedEnv: {},
        allowStdin: false,
        commandClass: "inspect",
        timeoutMs: 30000,
        maxOutputBytes: 1048576
      }
    ]),
    "utf8"
  );
  return { root: rootReal, commandsFile };
}

const readOnly = {
  id: "alpha",
  roots: { read: "/home/read" },
  profiles: ["read-only"] as const
};
const minimal = {
  id: "alpha",
  roots: { read: "/home/read", write: "/home/write" },
  profiles: ["minimal"] as const
};

function compiled(doc: Parameters<typeof compilePolicyDocument>[0]): Promise<CompiledPolicyInput> {
  return compilePolicyDocument(doc);
}

async function snapshot(
  doc: Parameters<typeof compilePolicyDocument>[0]
): Promise<ActivePolicySnapshot> {
  return buildActivePolicySnapshot(await compilePolicyDocument(doc));
}

describe("approval: deterministic normalized risk classification", () => {
  it("detects adding a capability (read-only -> minimal) as risk-increasing", async () => {
    const before = await compiled({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    const after = await compiled({ schemaVersion: 1, workspaces: [{ ...minimal }] });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
  });

  it("detects broadening a read root as risk-increasing, narrowing is not", async () => {
    const dir = await makeTempDir();
    const narrow = await realpath(dir);
    const broad = join(narrow, "scope");
    await mkdir(broad);

    const narrowRoot = await compiled({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: broad }, profiles: ["read-only"] }]
    });
    const broadRoot = await compiled({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: narrow }, profiles: ["read-only"] }]
    });
    // Moving to a parent (broader) root is risk-increasing; moving into a child is not.
    expect(classifyPolicyRisk(narrowRoot, broadRoot).riskIncrease).toBe(true);
    expect(classifyPolicyRisk(broadRoot, narrowRoot).riskIncrease).toBe(false);
  });

  it("detects adding a workspace or client binding as risk-increasing", async () => {
    const one = await compiled({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: "/home/a" }, profiles: ["read-only"] }]
    });
    const two = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "alpha", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "beta", roots: { read: "/home/b" }, profiles: ["read-only"] }
      ]
    });
    const withBinding = await compiled({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: "/home/a" }, profiles: ["read-only"] }],
      clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
    });
    expect(classifyPolicyRisk(one, two).riskIncrease).toBe(true);
    expect(classifyPolicyRisk(one, withBinding).riskIncrease).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "detects adding or changing an exec child PATH as risk-increasing",
    async () => {
      const fixture = await makeExecFixture();
      const base = {
        id: "exec",
        roots: { read: "/home/e", exec: fixture.root },
        profiles: ["minimal"] as const
      };
      const before = await compiled({
        schemaVersion: 1,
        workspaces: [
          {
            ...base,
            exec: { commandsFile: fixture.commandsFile, path: "/usr/bin" }
          }
        ]
      });
      const after = await compiled({
        schemaVersion: 1,
        workspaces: [
          {
            ...base,
            exec: { commandsFile: fixture.commandsFile, path: "/usr/local/bin" }
          }
        ]
      });
      expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
    }
  );

  it("treats an access reduction (minimal -> read-only) as not risk-increasing", async () => {
    const before = await compiled({ schemaVersion: 1, workspaces: [{ ...minimal }] });
    const after = await compiled({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(false);
  });

  it("produces a deterministic summary with versions and counts only", async () => {
    const before = await snapshot({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    const after = await snapshot({ schemaVersion: 1, workspaces: [{ ...minimal }] });
    const summary = await buildPolicyChangeSummary(before, after);
    expect(summary.riskIncrease).toBe(true);
    expect(summary.previousVersion).toBe(before.version);
    expect(summary.candidateVersion).toBe(after.version);
    expect(summary.workspaceCount).toBe(1);
    expect(summary.bindingCount).toBe(0);
    const line = JSON.stringify(summary as unknown);
    expect(line).not.toContain("/home");
    expect(line).not.toContain("alpha");
  });
});

describe("approval: hook contract", () => {
  it("default hook is unavailable and never auto-approves", async () => {
    const before = await snapshot({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    const after = await snapshot({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    const summary = await buildPolicyChangeSummary(before, after);
    const decision: ApprovalDecision = await defaultApprovalHook(summary);
    expect(decision).toBe("unavailable");
  });

  it("a hook receives only a summary, not raw config", async () => {
    let receivedSummary: PolicyChangeSummary | undefined;
    const hook: ApprovalHook = async (change) => {
      receivedSummary = change;
      return "approved";
    };
    const before = await snapshot({ schemaVersion: 1, workspaces: [{ ...readOnly }] });
    const after = await snapshot({ schemaVersion: 1, workspaces: [{ ...minimal }] });
    const summary = await buildPolicyChangeSummary(before, after);
    const decision = await hook(summary);
    expect(decision).toBe("approved");
    expect(receivedSummary).toBe(summary);
    expect(JSON.stringify(receivedSummary as unknown)).not.toContain("/home");
    expect(JSON.stringify(receivedSummary as unknown)).not.toContain("alpha");
  });
});

describe("risk classifier: no privilege-escalation bypass", () => {
  it("flags a binding A -> B (same length, different workspace set) as risk-increasing", async () => {
    const before = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "b", roots: { read: "/home/b" }, profiles: ["read-only"] }
      ],
      clientBindings: [{ clientId: "client-1", workspaceIds: ["a", "b"] }]
    });
    // Same length (2), but the set changes: {a,b} -> {a,c} is a substitution, not a reduction.
    const after = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "c", roots: { read: "/home/c" }, profiles: ["read-only"] }
      ],
      clientBindings: [{ clientId: "client-1", workspaceIds: ["a", "c"] }]
    });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
  });

  it("flags adding a workspace to a binding even when another is removed", async () => {
    const before = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "b", roots: { read: "/home/b" }, profiles: ["read-only"] }
      ],
      clientBindings: [{ clientId: "client-1", workspaceIds: ["a"] }]
    });
    const after = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "a", roots: { read: "/home/a" }, profiles: ["read-only"] },
        { id: "b", roots: { read: "/home/b" }, profiles: ["read-only"] }
      ],
      clientBindings: [{ clientId: "client-1", workspaceIds: ["a", "b"] }]
    });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "flags the same commandId but a changed exec definition (binaryPath)",
    async () => {
      const dir = await makeTempDir();
      const rootReal = await realpath(dir);
      const scriptA = join(rootReal, "a.sh");
      const scriptB = join(rootReal, "b.sh");
      await writeFile(scriptA, "#!/bin/sh\necho a\n", { mode: 0o755 });
      await writeFile(scriptB, "#!/bin/sh\necho b\n", { mode: 0o755 });
      const writeCommands = async (binaryPath: string): Promise<string> => {
        const file = join(rootReal, `commands-${binaryPath.endsWith("a.sh") ? "a" : "b"}.json`);
        await writeFile(
          file,
          JSON.stringify([
            {
              commandId: "show-version",
              binaryPath,
              fixedArgs: ["--version"],
              allowExtraArgs: false,
              maxExtraArgs: 0,
              cwdMode: "fixed",
              fixedEnv: {},
              allowStdin: false,
              commandClass: "inspect",
              timeoutMs: 30000,
              maxOutputBytes: 1048576
            }
          ]),
          "utf8"
        );
        return file;
      };
      const commandsA = await writeCommands(scriptA);
      const commandsB = await writeCommands(scriptB);

      const before = await compiled({
        schemaVersion: 1,
        workspaces: [
          {
            id: "w",
            roots: { read: "/home/r", exec: rootReal },
            profiles: ["minimal"],
            exec: { commandsFile: commandsA, path: "/usr/bin" }
          }
        ]
      });
      const after = await compiled({
        schemaVersion: 1,
        workspaces: [
          {
            id: "w",
            roots: { read: "/home/r", exec: rootReal },
            profiles: ["minimal"],
            exec: { commandsFile: commandsB, path: "/usr/bin" }
          }
        ]
      });
      // Same commandId but a different binaryPath is a new definition -> risk increase.
      expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
    }
  );

  it("flags read-only -> read-only+minimal (adding a profile) as risk-increasing", async () => {
    // Both roots exist; adding the minimal profile grants write/edit/exec, an increase.
    const before = await compiled({
      schemaVersion: 1,
      workspaces: [
        { id: "a", roots: { read: "/home/a", write: "/home/w" }, profiles: ["read-only"] }
      ]
    });
    const after = await compiled({
      schemaVersion: 1,
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["read-only", "minimal"]
        }
      ]
    });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
  });

  it("flags expanding customCapabilities as risk-increasing even with roots unchanged", async () => {
    const before = await compiled({
      schemaVersion: 1,
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["custom"],
          customCapabilities: ["core.read"]
        }
      ]
    });
    const after = await compiled({
      schemaVersion: 1,
      workspaces: [
        {
          id: "a",
          roots: { read: "/home/a", write: "/home/w" },
          profiles: ["custom"],
          customCapabilities: ["core.read", "core.write"]
        }
      ]
    });
    expect(classifyPolicyRisk(before, after).riskIncrease).toBe(true);
  });
});
