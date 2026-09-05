import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpCredentialStore } from "../../src/owner/mcp-credential-store.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-mcp-credentials-"));
  cleanup.push(root);
  const directory = join(root, "credentials");
  return { directory, store: createMcpCredentialStore(directory) };
}

describe("MCP credential store", () => {
  it("stores secret material with safe metadata-only listing", async () => {
    const { directory, store } = await fixture();
    await store.set("github-token", { kind: "bearer", value: "super-secret-token" });
    expect(await store.list()).toEqual([{ ref: "github-token", kind: "bearer" }]);
    expect(await store.resolve(["github-token"])).toEqual([
      { kind: "bearer", value: "super-secret-token" }
    ]);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "github-token.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("supports custom HTTP headers and stdio env credentials", async () => {
    const { store } = await fixture();
    await store.set("api-key", { kind: "http-header", name: "X-API-Key", value: "secret" });
    await store.set("local-token", { kind: "env", name: "LOCAL_TOKEN", value: "secret2" });
    expect(await store.list()).toEqual([
      { ref: "api-key", kind: "http-header", name: "X-API-Key" },
      { ref: "local-token", kind: "env", name: "LOCAL_TOKEN" }
    ]);
  });

  it("rejects invalid refs and removes credentials", async () => {
    const { store } = await fixture();
    await expect(store.set("../escape", { kind: "bearer", value: "x" })).rejects.toThrow();
    await store.set("token", { kind: "bearer", value: "x" });
    await expect(store.remove("token")).resolves.toBe(true);
    await expect(store.remove("token")).resolves.toBe(false);
  });
});
