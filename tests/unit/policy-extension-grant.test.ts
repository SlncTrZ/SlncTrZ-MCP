import { describe, expect, it } from "vitest";
import {
  compilePolicyDocument,
  type ProfileName,
  type WorkspaceDefinition
} from "../../src/policy/policy-config.js";
import {
  buildActivePolicySnapshot,
  type ActivePolicySnapshot
} from "../../src/policy/policy-snapshot.js";
import { type AuthenticatedPrincipal } from "../../src/policy/kernel-policy.js";
import { classifyPolicyRisk } from "../../src/policy/approval.js";

const principal: AuthenticatedPrincipal = { clientId: "client-a", scopes: ["mcp:tools"] };

function manifestsOf(...ids: string[]) {
  return ids.map((id) => ({
    id,
    transport: "stdio" as const,
    version: "1.0.0",
    command: `/usr/local/bin/${id}-mcp`,
    tools: [{ canonicalId: `${id}.search`, riskClass: "read" as const }]
  }));
}

function workspaceWithGrants(
  grants: readonly {
    providerId: string;
    toolIds?: readonly string[];
    profiles?: readonly ProfileName[];
  }[],
  profiles: readonly ProfileName[] = ["read-only", "minimal"]
): WorkspaceDefinition {
  return {
    id: "ws-a",
    roots: { read: "/home/read" },
    profiles: [...profiles],
    extensionGrants: [...grants]
  };
}

async function snapshotWith(
  workspaces: readonly WorkspaceDefinition[],
  providerIds: readonly string[] = []
): Promise<ActivePolicySnapshot> {
  const compiled = await compilePolicyDocument({
    schemaVersion: 1,
    workspaces,
    extensions: manifestsOf(...providerIds),
    clientBindings: [{ clientId: "client-a", workspaceIds: workspaces.map((w) => w.id) }]
  });
  return buildActivePolicySnapshot(compiled);
}

describe("policy extension grants", () => {
  it("compiles a valid allow-all grant", async () => {
    await expect(
      snapshotWith([workspaceWithGrants([{ providerId: "github" }])], ["github"])
    ).resolves.toBeDefined();
  });

  it("rejects malformed or duplicate grants", async () => {
    for (const grants of [
      [{ providerId: "Bad Provider" }],
      [{ providerId: "github", toolIds: ["gh..bad"] }],
      [{ providerId: "github", toolIds: ["gitlab.x"] }],
      [{ providerId: "github", profiles: ["admin"] as never }],
      [{ providerId: "github" }, { providerId: "github", toolIds: ["github.search"] }]
    ]) {
      await expect(
        snapshotWith([workspaceWithGrants(grants)], ["github", "gitlab"])
      ).rejects.toMatchObject({ code: "policy_invalid" });
    }
  });

  it("rejects a grant whose provider or tool is not declared in the same candidate", async () => {
    await expect(
      snapshotWith([workspaceWithGrants([{ providerId: "github" }])], ["gitlab"])
    ).rejects.toMatchObject({ code: "policy_invalid" });
    await expect(
      snapshotWith(
        [workspaceWithGrants([{ providerId: "github", toolIds: ["github.missing"] }])],
        ["github"]
      )
    ).rejects.toMatchObject({ code: "policy_invalid" });
  });

  it("filters extensions by profile and tool grant", async () => {
    const snap = await snapshotWith(
      [
        workspaceWithGrants(
          [{ providerId: "github", toolIds: ["github.search"], profiles: ["minimal"] }],
          ["read-only", "minimal"]
        )
      ],
      ["github"]
    );
    expect(snap.resolve(principal, "ws-a", "read-only").extensions).toEqual([]);
    expect(snap.resolve(principal, "ws-a", "minimal").extensions).toEqual([
      { canonicalId: "github.search", providerId: "github", riskClass: "read" }
    ]);
  });

  it("allow-all exposes every declared provider tool", async () => {
    const snap = await snapshotWith(
      [workspaceWithGrants([{ providerId: "github" }], ["read-only"])],
      ["github"]
    );
    expect(
      snap.resolve(principal, "ws-a", "read-only").extensions.map((tool) => tool.canonicalId)
    ).toEqual(["github.search"]);
  });

  it("treats an extension grant or provider declaration change as risk-increasing", async () => {
    const base = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces: [workspaceWithGrants([], ["read-only"])],
      extensions: manifestsOf("github"),
      clientBindings: [{ clientId: "client-a", workspaceIds: ["ws-a"] }]
    });
    const granted = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces: [workspaceWithGrants([{ providerId: "github" }], ["read-only"])],
      extensions: manifestsOf("github"),
      clientBindings: [{ clientId: "client-a", workspaceIds: ["ws-a"] }]
    });
    expect(classifyPolicyRisk(base, granted).riskIncrease).toBe(true);
  });
});
