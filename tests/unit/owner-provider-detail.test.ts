import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { managedStatePaths } from "../../src/owner/managed-state.js";
import { createOwnerWebConsole } from "../../src/owner/web-console.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import type {
  McpCredentialMetadata,
  McpCredentialStore
} from "../../src/owner/mcp-credential-store.js";
import type { ManagedMcpProvider } from "../../src/owner/mcp-provider-store.js";
import type {
  McpDiscoveredSnapshot,
  McpProviderService
} from "../../src/owner/mcp-provider-service.js";
import type { ActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import type { PolicySnapshotStore } from "../../src/policy/policy-store.js";

const cleanup: (() => Promise<void>)[] = [];
const PASSPHRASE = "provider detail owner test value";

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function provider(overrides: Partial<ManagedMcpProvider> = {}): ManagedMcpProvider {
  return {
    id: "github",
    name: "GitHub",
    enabled: true,
    updatedAt: "2026-10-09T00:00:00.000Z",
    manifest: {
      id: "github",
      transport: "streamable-http",
      version: "1.0.0",
      endpoint: "https://github.example.com/mcp",
      tools: [
        { canonicalId: "github.list", riskClass: "read", description: "Lists repositories" },
        { canonicalId: "github.write", riskClass: "write" }
      ]
    },
    ...overrides
  };
}

function discoveredSnapshot(overrides: Partial<McpDiscoveredSnapshot> = {}): McpDiscoveredSnapshot {
  return {
    at: "2026-10-09T10:00:00.000Z",
    tools: [],
    diff: {
      providerId: "github",
      acceptedVersion: "a",
      discoveredVersion: "b",
      added: [],
      removed: [],
      changed: [],
      hasChanges: false
    },
    ...overrides
  } as McpDiscoveredSnapshot;
}

interface Harness {
  readonly origin: string;
  readonly calls: { discover: number; sync: number; setEnabled: number; remove: number };
  login(): Promise<{ cookie: string; csrf: string }>;
}

async function startOwner(options: {
  providers?: readonly ManagedMcpProvider[];
  credentials?: readonly McpCredentialMetadata[];
  discovered?: (providerId: string) => McpDiscoveredSnapshot | undefined;
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-provider-detail-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = managedStatePaths(root);
  await writeFile(
    paths.commandCatalogFile,
    JSON.stringify({ shell: { allowlist: { added: [] } } }),
    "utf8"
  );
  const compiled = await compilePolicyDocument({
    schemaVersion: 2,
    paths: [root],
    authorityMode: "restricted"
  });
  const snapshot = buildActivePolicySnapshot(compiled);
  const providers = options.providers ?? [];
  const credentials = options.credentials ?? [];
  const calls = { discover: 0, sync: 0, setEnabled: 0, remove: 0 };
  const mcpProviders = {
    async list() {
      return providers;
    },
    getDiscovered(providerId: string) {
      return options.discovered?.(providerId);
    },
    async setEnabled() {
      calls.setEnabled += 1;
      throw new Error("unexpected mutation");
    },
    async remove() {
      calls.remove += 1;
      throw new Error("unexpected mutation");
    },
    async discover() {
      calls.discover += 1;
      throw new Error("unexpected probe");
    },
    async syncToDiscovered() {
      calls.sync += 1;
      throw new Error("unexpected sync");
    },
    async addOrUpdate() {
      throw new Error("unexpected mutation");
    },
    async discoverCandidate() {
      throw new Error("unexpected probe");
    },
    async acceptToolSet() {
      throw new Error("unexpected mutation");
    },
    async toolDiff() {
      throw new Error("unexpected probe");
    }
  } as unknown as McpProviderService;
  const mcpCredentials = {
    async list() {
      return credentials;
    }
  } as unknown as McpCredentialStore;
  const web = createOwnerWebConsole({
    ownerSecretHash: createOwnerSecretHash(PASSPHRASE),
    policyStore: {
      capture: () =>
        ({
          ...snapshot,
          extensionStatus: () =>
            providers.map((entry) =>
              Object.freeze({
                providerId: entry.id,
                state: "ready" as const,
                health: "ready" as const
              })
            )
        }) as ActivePolicySnapshot,
      async reload() {
        return {
          activated: true,
          previousVersion: snapshot.version,
          activeVersion: snapshot.version,
          riskIncrease: false,
          result: "activated" as const
        };
      }
    } as Pick<PolicySnapshotStore, "capture" | "reload">,
    statePaths: paths,
    mutation: {
      async apply() {
        return {
          activated: true,
          previousVersion: snapshot.version,
          activeVersion: snapshot.version,
          riskIncrease: false,
          result: "activated" as const
        };
      },
      async validate() {
        return { valid: true as const, pathCount: 1 };
      }
    },
    mcpProviders,
    mcpCredentials,
    secureCookies: false
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void web
      .handle(req, res, pathname)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    calls,
    async login() {
      const response = await fetch(`${origin}/owner/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: PASSPHRASE })
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie") ?? "";
      const body = (await response.json()) as { csrf: string };
      return { cookie, csrf: body.csrf };
    }
  };
}

describe("Owner provider detail GET API", () => {
  it("returns a projected detail for an authenticated owner session", async () => {
    const { origin, calls, login } = await startOwner({ providers: [provider()] });
    const { cookie } = await login();
    const response = await fetch(`${origin}/owner/api/mcp/github/detail`, {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      name: string;
      enabled: boolean;
      status: string;
      connection: { kind: string; endpoint?: string };
      tools: { accepted: { canonicalId: string; riskClass: string; description?: string }[] };
    };
    expect(body.id).toBe("github");
    expect(body.name).toBe("GitHub");
    expect(body.enabled).toBe(true);
    expect(body.status).toBe("ready");
    expect(body.connection.kind).toBe("remote");
    expect(body.connection.endpoint).toBe("https://github.example.com/mcp");
    expect(body.tools.accepted).toEqual([
      { canonicalId: "github.list", riskClass: "read", description: "Lists repositories" },
      { canonicalId: "github.write", riskClass: "write" }
    ]);
    expect(calls.discover).toBe(0);
    expect(calls.sync).toBe(0);
    expect(calls.setEnabled).toBe(0);
    expect(calls.remove).toBe(0);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { origin } = await startOwner({ providers: [provider()] });
    const response = await fetch(`${origin}/owner/api/mcp/github/detail`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown provider id", async () => {
    const { origin, login } = await startOwner({ providers: [provider()] });
    const { cookie } = await login();
    const response = await fetch(`${origin}/owner/api/mcp/missing/detail`, {
      headers: { cookie }
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_provider");
  });

  it("returns 400 for a malformed provider id", async () => {
    const { origin, login } = await startOwner({ providers: [provider()] });
    const { cookie } = await login();
    // A percent-encoded slash decodes to a path separator — structurally invalid.
    const response = await fetch(`${origin}/owner/api/mcp/git%2Fhub/detail`, {
      headers: { cookie }
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_provider_id");
  });

  it("never exposes secrets, raw command args or auth values", async () => {
    const local = provider({
      id: "local",
      manifest: {
        id: "local",
        transport: "stdio",
        version: "1.0.0",
        command: "/usr/bin/node",
        args: ["--token", "sk_live_supersecret123"],
        credentialRefs: ["local-token"],
        tools: [{ canonicalId: "local.ping", riskClass: "read" }]
      }
    });
    const credentials: McpCredentialMetadata[] = [
      { ref: "local-token", kind: "http-header", name: "X-API-Key" }
    ];
    const { origin, login } = await startOwner({ providers: [local], credentials });
    const { cookie } = await login();
    const response = await fetch(`${origin}/owner/api/mcp/local/detail`, {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("sk_live_supersecret123");
    expect(raw).not.toContain("--token");
    const body = JSON.parse(raw) as {
      connection: { kind: string; command: string };
      auth: { kind: string; configured: boolean; name?: string };
    };
    expect(body.connection.kind).toBe("local");
    expect(body.connection.command).toBe("/usr/bin/node");
    expect(body.connection).not.toHaveProperty("args");
    expect(body.auth.kind).toBe("header");
    expect(body.auth.configured).toBe(true);
    expect(body.auth.name).toBe("X-API-Key");
  });

  it("surfaces cached probe timestamp and needsSync without probing", async () => {
    const discovered = discoveredSnapshot({
      tools: [{ canonicalId: "github.list", riskClass: "read" }],
      diff: {
        providerId: "github",
        acceptedVersion: "a",
        discoveredVersion: "b",
        added: [],
        removed: [],
        changed: [],
        hasChanges: true
      }
    });
    const { origin, calls, login } = await startOwner({
      providers: [provider()],
      discovered: (id) => (id === "github" ? discovered : undefined)
    });
    const { cookie } = await login();
    const response = await fetch(`${origin}/owner/api/mcp/github/detail`, {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      tools: { needsSync: boolean; discoveredCount?: number };
      health: { lastProbeAt?: string; needsSync: boolean };
    };
    expect(body.status).toBe("needs_sync");
    expect(body.tools.needsSync).toBe(true);
    expect(body.tools.discoveredCount).toBe(1);
    expect(body.health.lastProbeAt).toBe("2026-10-09T10:00:00.000Z");
    expect(body.health.needsSync).toBe(true);
    expect(calls.discover).toBe(0);
    expect(calls.sync).toBe(0);
  });
});
