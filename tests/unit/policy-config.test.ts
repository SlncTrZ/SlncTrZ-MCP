import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compilePolicyDocument,
  loadPolicyDocument,
  type PolicyConfigError
} from "../../src/policy/policy-config.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-policy-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("policy config (typed document + compile)", () => {
  it("compiles an empty workspace array to deny-all", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 1, workspaces: [] });
    expect(compiled.workspaces).toEqual([]);
    expect(compiled.clientBindings).toEqual([]);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it("compiles a read-only workspace and canonicalizes its roots", async () => {
    const compiled = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: join(tmpdir(), "a") }, profiles: ["read-only"] }]
    });
    const workspace = compiled.workspaces[0];
    expect(workspace?.id).toBe("alpha");
    expect(workspace?.kernelPolicy.capabilities).toEqual(["core.read", "core.search"]);
    expect(workspace?.kernelPolicy.writeRoot).toBeUndefined();
    expect(Object.isFrozen(workspace?.kernelPolicy)).toBe(true);
  });

  it("rejects an unsupported schema version", async () => {
    await expect(
      compilePolicyDocument({ schemaVersion: 2, workspaces: [] } as never)
    ).rejects.toMatchObject({ code: "policy_schema_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("rejects a workspace with no root", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: {}, profiles: ["read-only"] }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("rejects a relative root", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: "relative/read" }, profiles: ["read-only"] }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("rejects duplicate workspace ids and duplicate client bindings", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          { id: "a", roots: { read: "/r" }, profiles: ["read-only"] },
          { id: "a", roots: { read: "/r2" }, profiles: ["read-only"] }
        ]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);

    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [
          { clientId: "c1", workspaceIds: ["a"] },
          { clientId: "c1", workspaceIds: ["a"] }
        ]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("rejects an unknown binding target and a default outside the bound set", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "c1", workspaceIds: ["a"], defaultWorkspaceId: "missing" }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);

    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "c1", workspaceIds: ["a"] }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).resolves.toBeTruthy();
  });

  it("rejects a custom profile without explicit capabilities", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: "/r" }, profiles: ["custom"] }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("rejects exec without an exec root and a relative commands file", async () => {
    await expect(
      compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          { id: "a", roots: { read: "/r" }, profiles: ["read-only"], exec: { commandsFile: "/c" } }
        ]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never)
    ).rejects.toMatchObject({ code: "policy_invalid" } satisfies Partial<PolicyConfigError>);
  });

  it("never leaks path or config content in error messages", async () => {
    const secretRoot = "relative-to-leak";
    let caught: unknown;
    try {
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "a", roots: { read: secretRoot }, profiles: ["read-only"] }]
      } satisfies Parameters<typeof compilePolicyDocument>[0] as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(secretRoot);
    expect(message).not.toContain("schemaVersion");
  });

  it("loads a valid policy file and rejects an unreadable one", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "policy.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, workspaces: [] }), "utf8");
    const doc = await loadPolicyDocument(file);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.workspaces).toEqual([]);

    await expect(loadPolicyDocument(join(dir, "missing.json"))).rejects.toMatchObject({
      code: "policy_file_missing"
    } satisfies Partial<PolicyConfigError>);

    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    await expect(loadPolicyDocument(bad)).rejects.toMatchObject({
      code: "policy_file_invalid"
    } satisfies Partial<PolicyConfigError>);
  });

  it("rejects unknown nested keys in every strict object", async () => {
    const dir = await makeTempDir();
    const docs: [string, Record<string, unknown>][] = [
      [
        "root",
        {
          schemaVersion: 1,
          workspaces: [{ id: "a", roots: { read: "/r", extra: 1 }, profiles: ["read-only"] }]
        }
      ],
      [
        "exec",
        {
          schemaVersion: 1,
          workspaces: [
            {
              id: "a",
              roots: { read: "/r", exec: "/e" },
              profiles: ["minimal"],
              exec: { commandsFile: "/c.json", extra: 1 }
            }
          ]
        }
      ],
      [
        "binding",
        {
          schemaVersion: 1,
          workspaces: [{ id: "a", roots: { read: "/r" }, profiles: ["read-only"] }],
          clientBindings: [{ clientId: "c", workspaceIds: ["a"], extra: 1 }]
        }
      ],
      [
        "workspace",
        {
          schemaVersion: 1,
          workspaces: [
            { id: "a", roots: { read: "/r" }, profiles: ["read-only"], unexpected: true }
          ]
        }
      ]
    ];
    for (const [where, doc] of docs) {
      const file = join(dir, `${where}.json`);
      await writeFile(file, JSON.stringify(doc), "utf8");
      await expect(loadPolicyDocument(file)).rejects.toMatchObject({
        code: "policy_schema_invalid"
      } satisfies Partial<PolicyConfigError>);
    }
  });
});
