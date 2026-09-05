import { describe, expect, it } from "vitest";
import { compilePolicyDocument, parsePolicyDocument } from "../../src/policy/policy-config.js";

describe("simple product policy compiler", () => {
  it("compiles shared paths into the same read/write/run authority", async () => {
    const compiled = await compilePolicyDocument({ schemaVersion: 2, paths: ["/tmp/a", "/tmp/b"] });
    expect(compiled.kernelPolicy.readRoots).toEqual(["/tmp/a", "/tmp/b"]);
    expect(compiled.kernelPolicy.writeRoots).toEqual(["/tmp/a", "/tmp/b"]);
    expect(compiled.kernelPolicy.runRoots).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("migrates legacy workspace roots only at the parse boundary", () => {
    const parsed = parsePolicyDocument({
      schemaVersion: 1,
      workspaces: [
        {
          id: "default",
          roots: { read: "/tmp/read", write: "/tmp/write", run: "/tmp/run" },
          profiles: ["custom"],
          customCapabilities: ["core.exec"]
        }
      ],
      clientBindings: [{ clientId: "old", workspaceIds: ["default"] }],
      fallbackWorkspaceId: "default"
    });
    expect(parsed).toEqual({
      schemaVersion: 2,
      paths: ["/tmp/read", "/tmp/write", "/tmp/run"],
      authorityMode: "restricted"
    });
    expect("clientBindings" in parsed).toBe(false);
    expect("fallbackWorkspaceId" in parsed).toBe(false);
  });

  it("accepts autonomous authority mode without changing Paths", async () => {
    const parsed = parsePolicyDocument({
      schemaVersion: 2,
      paths: ["/tmp/project"],
      authorityMode: "autonomous"
    });
    expect(parsed.authorityMode).toBe("autonomous");
    const compiled = await compilePolicyDocument(parsed);
    expect(compiled.kernelPolicy.authorityMode).toBe("autonomous");
    expect(compiled.kernelPolicy.capabilities).toEqual([
      "core.read",
      "core.search",
      "core.write",
      "core.edit",
      "core.exec"
    ]);
  });
});
