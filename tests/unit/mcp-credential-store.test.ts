import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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

  it("persists only systemd descriptors and lists metadata without reading runtime files", async () => {
    const { directory, store } = await fixture();
    const descriptor = {
      kind: "systemd-bearer",
      unit: "factory-test.service",
      credential: "factory-token"
    } as const;
    await store.set("factory", descriptor);
    expect(JSON.parse(await readFile(join(directory, "factory.json"), "utf8"))).toEqual(descriptor);
    expect(await store.list()).toEqual([{ ref: "factory", kind: "bearer", source: "systemd" }]);
  });

  it("rejects traversal, invalid unit names and credentials containing a value", async () => {
    const { store } = await fixture();
    for (const unit of ["../other.service", "factory.service/other", "factory.timer"]) {
      await expect(
        store.set("bad", { kind: "systemd-bearer", unit, credential: "factory-token" })
      ).rejects.toThrow("mcp_credential_invalid");
    }
    for (const credential of ["../token", "..", "token/other", "token\nother"]) {
      await expect(
        store.set("bad", { kind: "systemd-bearer", unit: "factory.service", credential })
      ).rejects.toThrow("mcp_credential_invalid");
    }
    await expect(
      store.set("bad", {
        kind: "systemd-bearer",
        unit: "factory.service",
        credential: "token",
        value: "not-a-descriptor"
      } as never)
    ).rejects.toThrow("mcp_credential_invalid");
  });

  it.runIf(process.platform !== "linux")(
    "rejects systemd resolution explicitly on unsupported platforms",
    async () => {
      const { store } = await fixture();
      await store.set("factory", {
        kind: "systemd-bearer",
        unit: "factory.service",
        credential: "token"
      });
      await expect(store.resolve(["factory"])).rejects.toThrow(
        "mcp_systemd_credential_platform_invalid"
      );
    }
  );
});

describe.runIf(process.platform === "linux")("systemd bearer credential references", () => {
  async function systemdFixture() {
    const { directory } = await fixture();
    const root = await mkdtemp(join(tmpdir(), "slnctrz-systemd-"));
    cleanup.push(root);
    const unit = "factory-test.service";
    const parent = join(root, unit);
    await mkdir(parent, { mode: 0o700 });
    const path = join(parent, "factory-token");
    const value = randomBytes(32).toString("hex");
    await writeFile(path, value, { mode: 0o600 });
    const store = createMcpCredentialStore(directory, { systemdCredentialsRoot: root });
    await store.set("factory", { kind: "systemd-bearer", unit, credential: "factory-token" });
    return { store, directory, path, parent, value };
  }

  it("resolves each current runtime value, including rotation, without persisting it", async () => {
    const { store, directory, path, value } = await systemdFixture();
    expect(await store.resolve(["factory", "factory"])).toEqual([{ kind: "bearer", value }]);
    const replacement = randomBytes(32).toString("hex");
    await writeFile(path, replacement + "\n");
    expect(await store.resolve(["factory"])).toEqual([{ kind: "bearer", value: replacement }]);
    const persisted = await readFile(join(directory, "factory.json"), "utf8");
    expect(persisted).not.toContain(value);
    expect(persisted).not.toContain(replacement);
    await rm(path);
    await expect(store.resolve(["factory"])).rejects.toThrow("mcp_systemd_credential_unavailable");
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects permissive files, oversized values, empty values and embedded controls", async () => {
    const { store, path, value } = await systemdFixture();
    await chmod(path, 0o644);
    await expect(store.resolve(["factory"])).rejects.toThrow("mcp_systemd_credential_unavailable");
    await chmod(path, 0o600);
    for (const invalid of [
      "a".repeat(16_385),
      "",
      " \n",
      value + " other",
      value + "\u0000",
      value + "\u007f"
    ]) {
      await writeFile(path, invalid);
      await expect(store.resolve(["factory"])).rejects.toThrow(
        "mcp_systemd_credential_unavailable"
      );
    }
    await writeFile(path, "a".repeat(16_384));
    expect((await store.resolve(["factory"]))[0]).toEqual({
      kind: "bearer",
      value: "a".repeat(16_384)
    });
  });

  it("rejects symlinked credential files and unit directories", async () => {
    const { store, path, parent } = await systemdFixture();
    await rm(path);
    await symlink(join(parent, "absent"), path);
    await expect(store.resolve(["factory"])).rejects.toThrow("mcp_systemd_credential_unavailable");
    await rm(path);
    const moved = parent + "-moved";
    await rename(parent, moved);
    await symlink(moved, parent);
    await expect(store.resolve(["factory"])).rejects.toThrow("mcp_systemd_credential_unavailable");
  });

  it("rejects directories and FIFOs without waiting for a writer", async () => {
    const { store, path } = await systemdFixture();
    await rm(path);
    await mkdir(path, { mode: 0o700 });
    await expect(store.resolve(["factory"])).rejects.toThrow("mcp_systemd_credential_unavailable");
    await rm(path, { recursive: true });
    execFileSync("mkfifo", ["-m", "600", path]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = store.resolve(["factory"]).then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      const beforeWriter = await Promise.race([
        result,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 1000);
        })
      ]);
      if (beforeWriter === undefined) {
        const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
        await result;
      }
      expect(beforeWriter).toBeInstanceOf(Error);
      expect((beforeWriter as Error).message).toBe("mcp_systemd_credential_unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
});
