import { describe, expect, it } from "vitest";
import {
  compileExtensionManifest,
  type ExtensionManifestV1
} from "../../src/extension/manifest.js";

function validStdio(): ExtensionManifestV1 {
  return {
    id: "github",
    transport: "stdio",
    version: "1.0.0",
    command: "/usr/local/bin/github-mcp",
    args: ["--host", "github.example.com"],
    tools: [
      { canonicalId: "github.search", riskClass: "read" },
      { canonicalId: "github.issue.create", riskClass: "write" }
    ],
    workspaces: ["dev"],
    envAllowlist: ["GITHUB_TOKEN"],
    credentialRefs: ["cred.github"],
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    maxOutputBytes: 1_048_576,
    maxMessageBytes: 65_536,
    maxQueue: 16,
    maxRestarts: 3
  };
}

describe("extension manifest (typed strict JSON schema)", () => {
  it("compiles a valid stdio manifest", async () => {
    const compiled = await compileExtensionManifest(validStdio());
    expect(compiled.id).toBe("github");
    expect(compiled.transport).toBe("stdio");
    expect(compiled.tools).toHaveLength(2);
  });

  it("rejects an invalid provider id (uppercase/whitespace/empty)", async () => {
    for (const bad of ["Github", "gh repo", "", "gh!repo"]) {
      await expect(
        compileExtensionManifest({ ...validStdio(), id: bad } as ExtensionManifestV1)
      ).rejects.toMatchObject({ code: "manifest_schema_invalid" });
    }
  });

  it("rejects an unknown transport", async () => {
    await expect(
      compileExtensionManifest({ ...validStdio(), transport: "grpc" } as never)
    ).rejects.toMatchObject({ code: "manifest_schema_invalid" });
  });

  it("rejects unknown top-level and nested keys (strict)", async () => {
    await expect(
      compileExtensionManifest({ ...validStdio(), shell: "true" } as never)
    ).rejects.toMatchObject({ code: "manifest_schema_invalid" });
    await expect(
      compileExtensionManifest({
        ...validStdio(),
        tools: [{ canonicalId: "gh.search", riskClass: "read", extra: 1 }]
      } as never)
    ).rejects.toMatchObject({ code: "manifest_schema_invalid" });
  });

  it("rejects a shell string in the command (no arbitrary caller endpoint)", async () => {
    await expect(
      compileExtensionManifest({ ...validStdio(), command: "echo $(id)" } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("rejects a relative or non-absolute stdio command", async () => {
    await expect(
      compileExtensionManifest({ ...validStdio(), command: "github-mcp" } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("rejects an HTTP endpoint that is not HTTPS", async () => {
    const http = {
      ...validStdio(),
      transport: "streamable-http",
      endpoint: "http://x.example.com"
    } as ExtensionManifestV1;
    await expect(compileExtensionManifest(http)).rejects.toMatchObject({
      code: "manifest_invalid"
    });
  });

  it("rejects a wildcard workspace id", async () => {
    await expect(
      compileExtensionManifest({ ...validStdio(), workspaces: ["*"] } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("rejects an inline secret value in credential refs or env allowlist", async () => {
    await expect(
      compileExtensionManifest({
        ...validStdio(),
        credentialRefs: ["sk_live_SECRET_VALUE"]
      } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("redacts the provider id and credential refs from error messages", async () => {
    let caught: unknown;
    try {
      await compileExtensionManifest({
        ...validStdio(),
        id: "bad id", // invalid but must not leak in the message
        credentialRefs: ["sk_live_TOP_SECRET"]
      } as ExtensionManifestV1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain("TOP_SECRET");
    expect(msg).not.toContain("bad id");
  });

  it("rejects fields mixed across transports (stdio endpoint / http command)", async () => {
    await expect(
      compileExtensionManifest({
        ...validStdio(),
        endpoint: "https://example.com/mcp"
      } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
    await expect(
      compileExtensionManifest({
        ...validStdio(),
        transport: "streamable-http",
        endpoint: "https://example.com/mcp",
        command: "/usr/local/bin/x"
      } as ExtensionManifestV1)
    ).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("rejects limits above the hard ceiling", async () => {
    const cases = [
      { maxOutputBytes: 9 * 1_048_576 },
      { maxMessageBytes: 2 * 1_048_576 },
      { maxQueue: 513 },
      { maxRestarts: 17 },
      { startupTimeoutMs: 121_000 },
      { requestTimeoutMs: 121_000 }
    ];
    for (const override of cases) {
      await expect(
        compileExtensionManifest({ ...validStdio(), ...override } as ExtensionManifestV1)
      ).rejects.toMatchObject({ code: "manifest_invalid" });
    }
  });

  it("rejects malformed canonical tool ids (format, not namespace)", async () => {
    for (const bad of ["github.", "github..x", "gh repo", "gh\tname"]) {
      await expect(
        compileExtensionManifest({
          ...validStdio(),
          tools: [{ canonicalId: bad, riskClass: "read" }]
        } as ExtensionManifestV1)
      ).rejects.toMatchObject({ code: "manifest_invalid" });
    }
  });
});
