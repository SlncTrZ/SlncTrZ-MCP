import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import {
  authorizeKernelCapability,
  authorizeRunKernelCommand,
  createKernelPolicySnapshot,
  KernelPolicyError
} from "../../src/policy/kernel-policy.js";

const principal = { clientId: "client-a", scopes: ["mcp:tools"] };

describe("simple kernel policy", () => {
  it("derives filesystem capabilities from one shared Paths set", () => {
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "default",
      readRoots: ["/tmp/a", "/tmp/b"],
      writeRoots: ["/tmp/a", "/tmp/b"],
      runRoots: ["/tmp/a", "/tmp/b"]
    });
    expect(snapshot.capabilities).toEqual(["core.read", "core.search", "core.write", "core.edit"]);
    expect(snapshot.readRoots).toEqual(["/tmp/a", "/tmp/b"]);
    expect(snapshot.writeRoots).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("authorizes exec only through command.json + Paths", () => {
    const root = tmpdir();
    const catalog = compileCommandCatalog([["node", "--version"]]);
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "default",
      readRoots: [root],
      writeRoots: [root],
      runRoots: [root],
      commandCatalog: catalog
    });
    expect(snapshot.capabilities).toContain("core.exec");
    const authorized = authorizeRunKernelCommand(snapshot, principal, "node", "--version");
    expect(authorized.runRoot).toBe(root);
    expect(authorized.binary).toContain("node");
    expect(() => authorizeRunKernelCommand(snapshot, principal, "node", "--eval")).toThrow(
      KernelPolicyError
    );
  });

  it("authorizes autonomous execution without command catalog or workspace restriction", () => {
    const root = tmpdir();
    const snapshot = createKernelPolicySnapshot({
      workspaceId: "default",
      authorityMode: "autonomous",
      readRoots: [root],
      writeRoots: [root],
      runRoots: [root]
    });
    expect(snapshot.capabilities).toEqual([
      "core.read",
      "core.search",
      "core.write",
      "core.edit",
      "core.exec"
    ]);
    const authorized = authorizeRunKernelCommand(
      snapshot,
      principal,
      process.execPath,
      "--version",
      root
    );
    expect(authorized.binary).toBe(process.execPath);
    expect(authorized.runRoot).toBe(root);
    expect(authorizeKernelCapability(snapshot, principal, "core.read").authorityMode).toBe(
      "autonomous"
    );
  });

  it("requires authenticated MCP scope for core access", () => {
    const snapshot = createKernelPolicySnapshot({ workspaceId: "default", readRoots: ["/tmp"] });
    expect(authorizeKernelCapability(snapshot, principal, "core.read").root).toBe("/tmp");
    expect(() =>
      authorizeKernelCapability(snapshot, { clientId: "x", scopes: [] }, "core.read")
    ).toThrow(KernelPolicyError);
  });
});
