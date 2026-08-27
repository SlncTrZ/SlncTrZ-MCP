import { describe, expect, it } from "vitest";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import {
  buildActivePolicySnapshot,
  type ActivePolicySnapshot
} from "../../src/policy/policy-snapshot.js";
import { type PolicyConfigError } from "../../src/policy/policy-config.js";

const principal = { clientId: "client-a", scopes: ["mcp:tools"] };

async function snapshotFromDocs(
  docs: Parameters<typeof compilePolicyDocument>[0][]
): Promise<ActivePolicySnapshot> {
  const doc = docs[0];
  if (doc === undefined) throw new Error("missing document");
  return buildActivePolicySnapshot(await compilePolicyDocument(doc));
}

describe("policy snapshot (immutable, versioned, resolve)", () => {
  it("produces the same version for equivalent logical ordering", async () => {
    const a = await buildActivePolicySnapshot(
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          { id: "alpha", roots: { read: "/r", write: "/w" }, profiles: ["minimal"] },
          { id: "beta", roots: { read: "/r2" }, profiles: ["read-only"] }
        ],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha", "beta"] }]
      })
    );
    const b = await buildActivePolicySnapshot(
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          { id: "beta", roots: { read: "/r2" }, profiles: ["read-only"] },
          { id: "alpha", roots: { read: "/r", write: "/w" }, profiles: ["minimal"] }
        ],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["beta", "alpha"] }]
      })
    );
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("changes the version when roots, profiles, or bindings change", async () => {
    const base = await buildActivePolicySnapshot(
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      })
    );
    const differentRoot = await buildActivePolicySnapshot(
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r2" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      })
    );
    const differentBinding = await buildActivePolicySnapshot(
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-b", workspaceIds: ["alpha"] }]
      })
    );
    expect(differentRoot.version).not.toBe(base.version);
    expect(differentBinding.version).not.toBe(base.version);
  });

  it("returns a deeply immutable resolved snapshot", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    const resolved = snap.resolve(principal, "alpha");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.capabilities)).toBe(true);
    expect(() => {
      (resolved as unknown as { capabilities: string[] }).capabilities.push("core.write");
    }).toThrow();
  });

  it("denies an unknown client, workspace, and profile", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    expect(() => snap.resolve({ clientId: "other", scopes: ["mcp:tools"] }, "alpha")).toThrow(
      expect.objectContaining({ code: "workspace_denied" }) as Partial<PolicyConfigError>
    );
    expect(() => snap.resolve(principal, "beta")).toThrow(
      expect.objectContaining({ code: "workspace_denied" }) as Partial<PolicyConfigError>
    );
    expect(() => snap.resolve(principal, "alpha", "minimal")).toThrow(
      expect.objectContaining({ code: "profile_unknown" }) as Partial<PolicyConfigError>
    );
  });

  it("requires an explicit profile when the workspace has multiple profiles", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [
          {
            id: "alpha",
            roots: { read: "/r", write: "/w" },
            profiles: ["read-only", "minimal"]
          }
        ],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    expect(() => snap.resolve(principal, "alpha")).toThrow(
      expect.objectContaining({ code: "profile_unknown" }) as Partial<PolicyConfigError>
    );
    expect(snap.resolve(principal, "alpha", "read-only").capabilities).not.toContain("core.write");
    expect(snap.resolve(principal, "alpha", "minimal").capabilities).toContain("core.write");
  });

  it("read-only hides write/exec roots even when configured", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r", write: "/w" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    const resolved = snap.resolve(principal, "alpha");
    expect(resolved.capabilities).toEqual(["core.read", "core.search"]);
    expect(resolved.writeRoot).toBeUndefined();
    expect(resolved.readRoot).toBe("/r");
  });

  it("minimal exposes only physically configured capabilities", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["minimal"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    const resolved = snap.resolve(principal, "alpha");
    expect(resolved.capabilities).toEqual(["core.read", "core.search"]);
    expect(resolved.writeRoot).toBeUndefined();
  });

  it("different authorized selections yield disjoint capability sets", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [
          { id: "a", roots: { read: "/r", write: "/w" }, profiles: ["minimal"] },
          { id: "b", roots: { read: "/r2" }, profiles: ["read-only"] }
        ],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["a", "b"] }]
      }
    ]);
    const a = snap.resolve(principal, "a").capabilities;
    const b = snap.resolve(principal, "b").capabilities;
    expect(a).toContain("core.write");
    expect(b).not.toContain("core.write");
  });

  it("carries the resolved active version in the returned snapshot", async () => {
    const snap = await snapshotFromDocs([
      {
        schemaVersion: 1,
        workspaces: [{ id: "alpha", roots: { read: "/r" }, profiles: ["read-only"] }],
        clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
      }
    ]);
    expect(snap.resolve(principal, "alpha").version).toBe(snap.version);
  });
});
