import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolicyDocument } from "../../src/policy/policy-config.js";
import { currentReleaseTarget } from "../../src/standalone/release-manifest.js";
import { prepareProductSetup } from "../../src/standalone/product-setup.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

function releaseFetch(bytes: Buffer): typeof fetch {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = currentReleaseTarget();
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    artifacts: [
      {
        target,
        url: "https://objects.example.test/slnctrz-mcp",
        sha256,
        sizeBytes: bytes.byteLength,
        fileName: process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
      }
    ]
  });
  return (async (input) => {
    const url = String(input);
    return new Response(url.includes("manifest") ? manifest : bytes, { status: 200 });
  }) as typeof fetch;
}

async function roots() {
  const root = await directory("slnctrz-setup-");
  const workspace = await directory("slnctrz-setup-workspace-");
  return {
    workspace,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config")
  };
}

describe("product setup", () => {
  it("creates a local user installation without a public URL and hands off the passphrase once", async () => {
    const paths = await roots();
    const fetch = releaseFetch(Buffer.from("standalone-bytes"));
    const request = {
      installMode: "user" as const,
      port: 9123,
      initialPath: paths.workspace,
      authorityMode: "autonomous" as const,
      manifestUrl: "https://updates.example.test/manifest.json",
      installRoot: paths.installRoot,
      stateRoot: paths.stateRoot,
      configRoot: paths.configRoot
    };

    const first = await prepareProductSetup(request, { fetch, checkPort: async () => undefined });
    expect(first.mcpEndpoint).toBe("http://127.0.0.1:9123/mcp");
    expect(first.ownerConsoleUrl).toBe("http://127.0.0.1:9123/owner");
    expect(first.ownerPassphraseState).toBe("created");
    expect(first.firstRunOwnerPassphrase).toHaveLength(32);
    expect(await loadPolicyDocument(join(paths.stateRoot, "policy.json"))).toMatchObject({
      authorityMode: "autonomous",
      paths: [await realpath(paths.workspace)]
    });
    const config = await readFile(join(paths.configRoot, "gateway.env"), "utf8");
    expect(config).toContain("SLNCTRZ_PORT=9123");
    expect(config).not.toContain("SLNCTRZ_PUBLIC_URL");

    const second = await prepareProductSetup(request, { fetch, checkPort: async () => undefined });
    expect(second.installation.installationId).toBe(first.installation.installationId);
    expect(second.ownerPassphraseState).toBe("preserved");
    expect(second.firstRunOwnerPassphrase).toBeUndefined();
  });

  it("writes explicit public HTTPS configuration without coupling it to the listener host", async () => {
    const paths = await roots();
    const result = await prepareProductSetup(
      {
        installMode: "user",
        port: 8080,
        initialPath: paths.workspace,
        publicMcpUrl: "https://mcp.example.test/mcp",
        listenHost: "127.0.0.1",
        manifestUrl: "https://updates.example.test/manifest.json",
        installRoot: paths.installRoot,
        stateRoot: paths.stateRoot,
        configRoot: paths.configRoot
      },
      { fetch: releaseFetch(Buffer.from("standalone-bytes")), checkPort: async () => undefined }
    );

    expect(result.mcpEndpoint).toBe("https://mcp.example.test/mcp");
    const config = await readFile(join(paths.configRoot, "gateway.env"), "utf8");
    expect(config).toContain("SLNCTRZ_HOST=127.0.0.1");
    expect(config).toContain("SLNCTRZ_PORT=8080");
    expect(config).toContain("SLNCTRZ_PUBLIC_URL=https://mcp.example.test/mcp");
  });

  it("auto-provisions a static confidential client on first setup and preserves an edited secret", async () => {
    const paths = await roots();
    const fetch = releaseFetch(Buffer.from("standalone-bytes"));
    const request = {
      installMode: "user" as const,
      port: 9124,
      initialPath: paths.workspace,
      manifestUrl: "https://updates.example.test/manifest.json",
      installRoot: paths.installRoot,
      stateRoot: paths.stateRoot,
      configRoot: paths.configRoot
    };

    const first = await prepareProductSetup(request, { fetch, checkPort: async () => undefined });
    expect(first.staticClientId).toBe("slnctrz-mcp");
    expect(first.staticClientFile).toBe(join(paths.configRoot, "client.env"));
    expect(first.firstRunStaticClientSecret).toMatch(/^[0-9a-f]{48}$/u);
    const file = await readFile(first.staticClientFile, "utf8");
    expect(file).toContain("SLNCTRZ_CLIENT_ID=slnctrz-mcp");
    expect(file).toContain(`SLNCTRZ_CLIENT_SECRET=${first.firstRunStaticClientSecret}`);

    // An operator edits the secret; a reinstall must preserve it, not regenerate it.
    const operatorSecret = "custom-operator-secret";
    await writeFile(
      first.staticClientFile,
      [
        "SLNCTRZ_CLIENT_ID=slnctrz-mcp",
        `SLNCTRZ_CLIENT_SECRET=${operatorSecret}`,
        "SLNCTRZ_CLIENT_NAME=SlncTrZ-MCP",
        "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback"
      ].join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    const second = await prepareProductSetup(request, { fetch, checkPort: async () => undefined });
    expect(second.firstRunStaticClientSecret).toBeUndefined();
    const preserved = await readFile(second.staticClientFile, "utf8");
    expect(preserved).toContain(`SLNCTRZ_CLIENT_SECRET=${operatorSecret}`);
  });

  it.skipIf(process.platform !== "linux")(
    "requires an explicit initial Path for system mode",
    async () => {
      const paths = await roots();
      await expect(
        prepareProductSetup(
          {
            installMode: "system",
            manifestUrl: "https://updates.example.test/manifest.json",
            installRoot: paths.installRoot,
            stateRoot: paths.stateRoot,
            configRoot: paths.configRoot
          },
          { fetch: releaseFetch(Buffer.from("standalone-bytes")), checkPort: async () => undefined }
        )
      ).rejects.toThrow("explicit Initial Path");
    }
  );
});
