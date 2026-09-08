import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolicyDocument } from "../../src/policy/policy-config.js";
import { currentReleaseTarget } from "../../src/standalone/release-manifest.js";
import {
  migrateDefaultStaticClientRedirectUris,
  prepareProductSetup
} from "../../src/standalone/product-setup.js";

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
  it("creates a local user installation under the current OS user and preserves owner command edits", async () => {
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
    expect(first.runtimeAccount).toBe(userInfo().username);
    expect(first.runtimeIdentity.home).toBe(userInfo().homedir);
    expect(first.ownerPassphraseState).toBe("created");
    expect(first.firstRunOwnerPassphrase).toHaveLength(32);
    expect(await loadPolicyDocument(join(paths.stateRoot, "policy.json"))).toMatchObject({
      authorityMode: "autonomous",
      paths: [await realpath(paths.workspace)]
    });
    const config = await readFile(join(paths.configRoot, "gateway.env"), "utf8");
    expect(config).toContain("SLNCTRZ_PORT=9123");
    expect(config).not.toContain("SLNCTRZ_PUBLIC_URL");

    const freshCatalog = JSON.parse(
      await readFile(join(paths.stateRoot, "command.json"), "utf8")
    ) as {
      shell: { allowlist: { added: unknown[] } };
    };
    expect(freshCatalog.shell.allowlist.added.length).toBeGreaterThan(0);

    const ownerCatalog = `${JSON.stringify({ shell: { allowlist: { added: [] } } }, null, 2)}\n`;
    await writeFile(join(paths.stateRoot, "command.json"), ownerCatalog, "utf8");
    const second = await prepareProductSetup(request, { fetch, checkPort: async () => undefined });
    expect(second.installation.installationId).toBe(first.installation.installationId);
    expect(second.ownerPassphraseState).toBe("preserved");
    expect(second.firstRunOwnerPassphrase).toBeUndefined();
    expect(await readFile(join(paths.stateRoot, "command.json"), "utf8")).toBe(ownerCatalog);
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

  it("auto-provisions OAuth and migrates the legacy callback without changing the secret", async () => {
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
    expect(file).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(file).toContain(
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-117020455475406554788-mcp_truongcongdinh_org"
    );

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
    expect(preserved).toContain(
      "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-117020455475406554788-mcp_truongcongdinh_org"
    );
  });

  it("appends the current Gemini callback while preserving an older Gemini callback", () => {
    const existing = [
      "SLNCTRZ_CLIENT_ID=slnctrz-mcp",
      "SLNCTRZ_CLIENT_SECRET=preserved-secret",
      "SLNCTRZ_CLIENT_NAME=SlncTrZ-MCP",
      "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-102591365441280672080-mcp_truongcongdinh_org",
      ""
    ].join("\n");
    const migrated = migrateDefaultStaticClientRedirectUris(existing);
    expect(migrated).toContain("SLNCTRZ_CLIENT_SECRET=preserved-secret");
    expect(migrated).toContain(
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-102591365441280672080-mcp_truongcongdinh_org"
    );
    expect(migrated).toContain(
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-117020455475406554788-mcp_truongcongdinh_org"
    );
  });

  it("preserves custom OAuth redirect allowlists for a custom client ID", () => {
    const customized = [
      "SLNCTRZ_CLIENT_ID=custom-client",
      "SLNCTRZ_CLIENT_SECRET=custom-secret",
      "SLNCTRZ_CLIENT_NAME=Custom Client",
      "SLNCTRZ_CLIENT_REDIRECT_URIS=https://client.example.test/oauth/callback",
      ""
    ].join("\n");
    expect(migrateDefaultStaticClientRedirectUris(customized)).toBe(customized);
  });

  it("accepts an explicit static OAuth client ID and secret during setup", async () => {
    const paths = await roots();
    const result = await prepareProductSetup(
      {
        installMode: "user",
        port: 9125,
        initialPath: paths.workspace,
        manifestUrl: "https://updates.example.test/manifest.json",
        installRoot: paths.installRoot,
        stateRoot: paths.stateRoot,
        configRoot: paths.configRoot,
        clientId: "custom-client",
        clientSecret: "custom-client-secret"
      },
      { fetch: releaseFetch(Buffer.from("standalone-bytes")), checkPort: async () => undefined }
    );

    expect(result.staticClientId).toBe("custom-client");
    expect(result.firstRunStaticClientSecret).toBeUndefined();
    expect(await readFile(result.staticClientFile, "utf8")).toContain(
      ["SLNCTRZ_CLIENT_ID=custom-client", "SLNCTRZ_CLIENT_SECRET=custom-client-secret"].join("\n")
    );
  });

  it.skipIf(process.platform !== "linux")(
    "requires an explicit initial Path for system mode",
    async () => {
      const paths = await roots();
      const runtimeIdentity = Object.freeze({
        username: "test-owner",
        uid: 1001,
        gid: 1001,
        groupName: "test-owner",
        home: "/home/test-owner",
        runtimePath: process.env.PATH ?? "/usr/bin"
      });
      await expect(
        prepareProductSetup(
          {
            installMode: "system",
            manifestUrl: "https://updates.example.test/manifest.json",
            installRoot: paths.installRoot,
            stateRoot: paths.stateRoot,
            configRoot: paths.configRoot
          },
          {
            fetch: releaseFetch(Buffer.from("standalone-bytes")),
            checkPort: async () => undefined,
            resolveRuntimeIdentity: () => runtimeIdentity,
            verifyRuntimeBinary: () => true
          }
        )
      ).rejects.toThrow("explicit Initial Path");
    }
  );
});
