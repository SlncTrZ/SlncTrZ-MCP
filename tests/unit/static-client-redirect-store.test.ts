import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticClientRedirectStore,
  MAX_STATIC_CLIENT_REDIRECT_URIS
} from "../../src/auth/static-client-redirect-store.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-static-redirect-store-"));
  cleanup.push(root);
  return { file: join(root, "oauth-static-redirects.json") };
}

describe("static OAuth redirect file store", () => {
  it("atomically adds exact redirects, isolates client IDs, and remains idempotent", async () => {
    const { file } = await fixture();
    const store = createStaticClientRedirectStore(file);
    const redirect =
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-account-a";

    expect(store.load("custom-client")).toEqual([]);
    expect(store.add("custom-client", redirect, 100)).toEqual([redirect]);
    expect(store.add("custom-client", redirect, 101)).toEqual([redirect]);
    expect(store.load("other-client")).toEqual([]);
    expect(store.load("custom-client")).toEqual([redirect]);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      clients: [{ clientId: "custom-client", redirectUris: [redirect], updatedAt: 100 }]
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on invalid JSON, schema, duplicates, and broad POSIX permissions", async () => {
    const { file } = await fixture();
    const store = createStaticClientRedirectStore(file);

    await writeFile(file, "not-json", { mode: 0o600 });
    expect(() => store.load("client")).toThrow("oauth_static_redirect_store_invalid_json");

    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        clients: [
          { clientId: "same", redirectUris: [], updatedAt: 1 },
          { clientId: "same", redirectUris: [], updatedAt: 2 }
        ]
      }),
      { mode: 0o600 }
    );
    expect(() => store.load("same")).toThrow("oauth_static_redirect_store_duplicate_client");

    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        clients: [{ clientId: "a", redirectUris: ["https://a.example/cb"], updatedAt: 1 }],
        unexpected: true
      }),
      { mode: 0o600 }
    );
    expect(() => store.load("a")).toThrow("oauth_static_redirect_store_invalid_schema");

    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      expect(() => store.load("a")).toThrow("oauth_static_redirect_store_permissions_too_broad");
    }
  });

  it("enforces the per-client redirect capacity without modifying persisted state", async () => {
    const { file } = await fixture();
    const store = createStaticClientRedirectStore(file);
    for (let index = 0; index < MAX_STATIC_CLIENT_REDIRECT_URIS; index += 1) {
      store.add(
        "client",
        `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-${index}`,
        index
      );
    }

    expect(() =>
      store.add(
        "client",
        "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-overflow",
        100
      )
    ).toThrow("oauth_static_redirect_store_capacity_exhausted");
    expect(store.load("client")).toHaveLength(MAX_STATIC_CLIENT_REDIRECT_URIS);
  });
});
