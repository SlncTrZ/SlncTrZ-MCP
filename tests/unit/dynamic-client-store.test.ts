import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDynamicClientFileStore } from "../../src/auth/dynamic-client-store.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-oauth-store-"));
  cleanup.push(root);
  return { root, file: join(root, "oauth-clients.json") };
}

describe("dynamic OAuth client file store", () => {
  it("atomically saves and reloads bounded client records with private permissions", async () => {
    const { file } = await fixture();
    const store = createDynamicClientFileStore(file, 4);
    store.save([
      {
        clientId: "client-a",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        issuedAt: 1
      }
    ]);

    expect(store.load()).toEqual([
      {
        clientId: "client-a",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        issuedAt: 1
      }
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on invalid JSON, duplicate ids, and capacity overflow", async () => {
    const { file } = await fixture();
    const store = createDynamicClientFileStore(file, 1);
    await writeFile(file, "not-json", { mode: 0o600 });
    expect(() => store.load()).toThrow("oauth_client_store_invalid_json");

    await writeFile(
      file,
      JSON.stringify([
        { clientId: "same", redirectUris: ["https://a.example/cb"], issuedAt: 1 },
        { clientId: "same", redirectUris: ["https://b.example/cb"], issuedAt: 2 }
      ]),
      { mode: 0o600 }
    );
    expect(() => store.load()).toThrow();

    expect(() =>
      store.save([
        { clientId: "a", redirectUris: ["https://a.example/cb"], issuedAt: 1 },
        { clientId: "b", redirectUris: ["https://b.example/cb"], issuedAt: 2 }
      ])
    ).toThrow("oauth_client_store_invalid_schema");
  });

  it("rejects a persisted registration file readable by group or others on POSIX", async () => {
    if (process.platform === "win32") return;
    const { file } = await fixture();
    await writeFile(
      file,
      JSON.stringify([{ clientId: "a", redirectUris: ["https://a.example/cb"], issuedAt: 1 }]),
      { mode: 0o600 }
    );
    await chmod(file, 0o644);
    const store = createDynamicClientFileStore(file, 4);
    expect(() => store.load()).toThrow("oauth_client_store_permissions_too_broad");
  });
});
