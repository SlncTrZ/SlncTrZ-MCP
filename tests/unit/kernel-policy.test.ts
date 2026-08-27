import { describe, expect, it } from "vitest";
import {
  authorizeKernelCapability,
  createKernelPolicySnapshot,
  type KernelPolicyError
} from "../../src/policy/kernel-policy.js";

const principal = {
  clientId: "client_test",
  scopes: ["mcp:tools"]
};

describe("kernel policy snapshot", () => {
  it("creates a frozen deterministic capability snapshot", () => {
    const first = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      readRoot: "/workspace/read",
      writeRoot: "/workspace/write"
    });
    const second = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      readRoot: "/workspace/read",
      writeRoot: "/workspace/write"
    });

    expect(first.version).toBe(second.version);
    expect(first.capabilities).toEqual(["core.read", "core.search", "core.write"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.capabilities)).toBe(true);
  });

  it("keeps write disabled unless a separate write root is configured", () => {
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      readRoot: "/workspace/read"
    });

    expect(snapshot.capabilities).toEqual(["core.read", "core.search"]);
    expect(() => authorizeKernelCapability(snapshot, principal, "core.write")).toThrowError(
      expect.objectContaining({ code: "capability_denied" }) as KernelPolicyError
    );
  });

  it("binds authorization to authenticated client, scope, workspace, and policy version", () => {
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      writeRoot: "/workspace/write"
    });

    expect(authorizeKernelCapability(snapshot, principal, "core.write")).toEqual({
      clientId: "client_test",
      workspaceId: "workspace-main",
      policyVersion: snapshot.version,
      capability: "core.write",
      root: "/workspace/write"
    });

    expect(() => authorizeKernelCapability(snapshot, undefined, "core.write")).toThrowError(
      expect.objectContaining({ code: "unauthenticated" }) as KernelPolicyError
    );
    expect(() =>
      authorizeKernelCapability(snapshot, { clientId: "x", scopes: [] }, "core.write")
    ).toThrowError(expect.objectContaining({ code: "scope_denied" }) as KernelPolicyError);
  });

  it("rejects ambiguous or relative roots", () => {
    expect(() =>
      createKernelPolicySnapshot({ workspaceId: "", writeRoot: "/workspace/write" })
    ).toThrow();
    expect(() =>
      createKernelPolicySnapshot({ workspaceId: "workspace-main", writeRoot: "relative" })
    ).toThrow();
  });
});
