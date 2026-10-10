import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { managedStatePaths } from "../../src/owner/managed-state.js";
import { createOwnerWebConsole } from "../../src/owner/web-console.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import {
  createWorkspacePreferenceStore,
  DEFAULT_WORKSPACE_DISPLAY_NAME,
  validateDisplayName,
  WorkspacePreferenceError
} from "../../src/owner/workspace-preference.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-workspace-preference-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "workspace-preference.json");
  return { file, store: createWorkspacePreferenceStore(file) };
}

describe("workspace preference store", () => {
  it("returns the default name for an absent file without creating it", async () => {
    const { file, store } = await fixture();
    await expect(store.get()).resolves.toEqual({ displayName: DEFAULT_WORKSPACE_DISPLAY_NAME });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a valid display name atomically across re-reads", async () => {
    const { file, store } = await fixture();
    const saved = await store.setDisplayName("My workspace");
    expect(saved).toEqual({ displayName: "My workspace" });

    const reRead = createWorkspacePreferenceStore(file);
    await expect(reRead.get()).resolves.toEqual({ displayName: "My workspace" });

    const raw = await readFile(file, "utf8");
    expect(raw).toContain('"schemaVersion": 1');
    expect(raw).toContain('"displayName": "My workspace"');
    // Atomic write must not leave temporary files behind.
    const entries = await readdir(join(file, ".."));
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("trims surrounding whitespace before persisting", async () => {
    const { store } = await fixture();
    const saved = await store.setDisplayName("   Workspace   ");
    expect(saved).toEqual({ displayName: "Workspace" });
  });

  it("accepts exactly 64 Unicode code points and rejects 65", async () => {
    expect(validateDisplayName("é".repeat(64))).toBe("é".repeat(64));
    expect(() => validateDisplayName("é".repeat(65))).toThrow(WorkspacePreferenceError);
  });

  it("rejects empty, whitespace-only and control-character names", async () => {
    for (const value of [
      "",
      "   ",
      "hello\nworld",
      "hello\tworld",
      "hello\rworld",
      "hello\u0000world",
      "hello\u007fworld"
    ]) {
      expect(() => validateDisplayName(value)).toThrow(WorkspacePreferenceError);
    }
  });

  it("rejects non-string input with a typed error", async () => {
    expect(() => validateDisplayName(42)).toThrow(WorkspacePreferenceError);
    expect(() => validateDisplayName(undefined)).toThrow(WorkspacePreferenceError);
    expect(() => validateDisplayName(null)).toThrow(WorkspacePreferenceError);
  });

  it("writes with owner-only permissions", async () => {
    const { file, store } = await fixture();
    await store.setDisplayName("Private workspace");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on a corrupt file and never overwrites it", async () => {
    const { file, store } = await fixture();
    await writeFile(file, "{ not valid json", "utf8");

    await expect(store.get()).rejects.toMatchObject({
      code: "preference_corrupt"
    } as Partial<WorkspacePreferenceError>);
    await expect(store.setDisplayName("Fresh name")).rejects.toMatchObject({
      code: "preference_corrupt"
    } as Partial<WorkspacePreferenceError>);
    // The corrupt content must remain untouched for owner action.
    await expect(readFile(file, "utf8")).resolves.toBe("{ not valid json");
  });

  it("fails closed when the stored display name is structurally invalid", async () => {
    const { file, store } = await fixture();
    await writeFile(file, JSON.stringify({ displayName: 42 }), "utf8");
    await expect(store.get()).rejects.toMatchObject({
      code: "preference_corrupt"
    } as Partial<WorkspacePreferenceError>);
  });
});

const PASSPHRASE = "workspace preference owner test value";

async function startOwner(): Promise<{ origin: string }> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-workspace-route-"));
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
  const web = createOwnerWebConsole({
    ownerSecretHash: createOwnerSecretHash(PASSPHRASE),
    policyStore: {
      capture: () => snapshot,
      async reload() {
        return {
          activated: true,
          previousVersion: snapshot.version,
          activeVersion: snapshot.version,
          riskIncrease: false,
          result: "activated" as const
        };
      }
    },
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
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function login(origin: string): Promise<{ cookie: string; csrf: string }> {
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

describe("Owner workspace preference API", () => {
  it("requires an owner session and CSRF for the write path", async () => {
    const { origin } = await startOwner();
    expect((await fetch(`${origin}/owner/api/workspace`)).status).toBe(401);

    const { cookie, csrf } = await login(origin);
    const missingCsrf = await fetch(`${origin}/owner/api/workspace`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed" })
    });
    expect(missingCsrf.status).toBe(403);

    const read = await fetch(`${origin}/owner/api/workspace`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ displayName: DEFAULT_WORKSPACE_DISPLAY_NAME });

    const updated = await fetch(`${origin}/owner/api/workspace`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ displayName: "Renamed" })
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true, displayName: "Renamed" });

    const persisted = await fetch(`${origin}/owner/api/workspace`, { headers: { cookie } });
    expect(await persisted.json()).toEqual({ displayName: "Renamed" });
  });

  it("rejects invalid display names with a typed 400", async () => {
    const { origin } = await startOwner();
    const { cookie, csrf } = await login(origin);
    for (const value of ["", "   ", "a".repeat(65), "line\nbreak"]) {
      const response = await fetch(`${origin}/owner/api/workspace`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
        body: JSON.stringify({ displayName: value })
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_display_name");
    }
  });
});
