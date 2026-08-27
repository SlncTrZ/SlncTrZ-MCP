import { describe, expect, it } from "vitest";
import {
  authorizeKernelCapability,
  authorizeKernelCommand,
  createKernelPolicySnapshot,
  type KernelPolicyError
} from "../../src/policy/kernel-policy.js";
import { type ExecCommandDefinition } from "../../src/kernel/exec.js";

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
    expect(first.capabilities).toEqual(["core.read", "core.search", "core.write", "core.edit"]);
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

    expect(authorizeKernelCapability(snapshot, principal, "core.edit")).toEqual({
      clientId: "client_test",
      workspaceId: "workspace-main",
      policyVersion: snapshot.version,
      capability: "core.edit",
      root: "/workspace/write"
    });

    expect(() => authorizeKernelCapability(snapshot, undefined, "core.write")).toThrowError(
      expect.objectContaining({ code: "unauthenticated" }) as KernelPolicyError
    );
    expect(() =>
      authorizeKernelCapability(snapshot, { clientId: "x", scopes: [] }, "core.edit")
    ).toThrowError(expect.objectContaining({ code: "scope_denied" }) as KernelPolicyError);
  });

  it("exposes core.edit only through an explicit write root", () => {
    const readOnly = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      readRoot: "/workspace/read"
    });
    expect(readOnly.capabilities).toEqual(["core.read", "core.search"]);
    expect(() => authorizeKernelCapability(readOnly, principal, "core.edit")).toThrowError(
      expect.objectContaining({ code: "capability_denied" }) as KernelPolicyError
    );

    const writeOnly = createKernelPolicySnapshot({
      workspaceId: "workspace-main",
      writeRoot: "/workspace/write"
    });
    expect(writeOnly.capabilities).toEqual(["core.write", "core.edit"]);
    expect(authorizeKernelCapability(writeOnly, principal, "core.edit")).toMatchObject({
      capability: "core.edit",
      root: "/workspace/write"
    });
    expect(() => authorizeKernelCapability(writeOnly, principal, "core.read")).toThrowError(
      expect.objectContaining({ code: "capability_denied" }) as KernelPolicyError
    );
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

describe.skipIf(process.platform === "win32")("core.exec policy", () => {
  const execCommand: ExecCommandDefinition = {
    commandId: "show-version",
    binaryPath: "/workspace/exec/show-version",
    fixedArgs: ["--version"],
    allowExtraArgs: false,
    maxExtraArgs: 0,
    cwdMode: "fixed",
    fixedEnv: {},
    allowStdin: false,
    commandClass: "inspect"
  };

  it("exposes core.exec only with an execRoot and a non-empty registry", () => {
    const none = createKernelPolicySnapshot({ workspaceId: "w", execRoot: "/workspace/exec" });
    expect(none.capabilities).toEqual([]);

    const empty = createKernelPolicySnapshot({
      workspaceId: "w",
      execRoot: "/workspace/exec",
      execCommands: []
    });
    expect(empty.capabilities).not.toContain("core.exec");

    const enabled = createKernelPolicySnapshot({
      workspaceId: "w",
      execRoot: "/workspace/exec",
      execCommands: [execCommand]
    });
    expect(enabled.capabilities).toEqual(["core.exec"]);
    expect(enabled.execRoot).toBe("/workspace/exec");
  });

  it("authorizes a known command and denies unknown or unauthenticated", () => {
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "w",
      execRoot: "/workspace/exec",
      execCommands: [execCommand]
    });
    expect(authorizeKernelCommand(snapshot, principal, "show-version")).toMatchObject({
      clientId: "client_test",
      workspaceId: "w",
      execRoot: "/workspace/exec"
    });
    expect(() => authorizeKernelCommand(snapshot, undefined, "show-version")).toThrowError(
      expect.objectContaining({ code: "unauthenticated" }) as KernelPolicyError
    );
    expect(() => authorizeKernelCommand(snapshot, principal, "does-not-exist")).toThrowError(
      expect.objectContaining({ code: "capability_denied" }) as KernelPolicyError
    );
  });

  it("rejects execRoot overlapping writeRoot in both directions", () => {
    expect(() =>
      createKernelPolicySnapshot({
        workspaceId: "w",
        writeRoot: "/workspace/shared",
        execRoot: "/workspace/shared",
        execCommands: [execCommand]
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_policy" }) as KernelPolicyError);
    expect(() =>
      createKernelPolicySnapshot({
        workspaceId: "w",
        writeRoot: "/workspace",
        execRoot: "/workspace/shared",
        execCommands: [execCommand]
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_policy" }) as KernelPolicyError);
  });

  it("allows execRoot overlapping readRoot", () => {
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "w",
      readRoot: "/workspace/shared",
      execRoot: "/workspace/shared",
      execCommands: [execCommand]
    });
    expect(snapshot.capabilities).toContain("core.exec");
  });

  it("changes the version when the command registry changes", () => {
    const base = createKernelPolicySnapshot({
      workspaceId: "w",
      execRoot: "/workspace/exec",
      execCommands: [execCommand]
    });
    const changed = createKernelPolicySnapshot({
      workspaceId: "w",
      execRoot: "/workspace/exec",
      execCommands: [{ ...execCommand, fixedArgs: ["-v"] }]
    });
    expect(base.version).not.toBe(changed.version);
  });
});
