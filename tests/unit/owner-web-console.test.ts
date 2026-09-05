import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";
import { managedStatePaths } from "../../src/owner/managed-state.js";
import { createOwnerWebConsole } from "../../src/owner/web-console.js";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import type { OwnerPolicyOperation } from "../../src/owner/policy-mutation.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("Owner Console product surface", () => {
  it("supports local HTTP session cookies, product state, CSRF and typed Autonomy mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-web-"));
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
    const operations: OwnerPolicyOperation[] = [];
    let commandReloadMode: "activated" | "failed" | "throw" | "recovery-fail" = "activated";
    let commandReloadGate: Promise<void> | undefined;
    let commandReloadCalls = 0;
    const web = createOwnerWebConsole({
      ownerSecretHash: createOwnerSecretHash("owner passphrase test value"),
      policyStore: {
        capture: () => snapshot,
        async reload() {
          commandReloadCalls += 1;
          if (commandReloadGate !== undefined) await commandReloadGate;
          if (commandReloadMode === "throw") throw new Error("reload_boom");
          if (commandReloadMode === "recovery-fail") {
            await rm(root, { recursive: true, force: true });
            await writeFile(root, "not-a-directory", "utf8");
          }
          const activated = commandReloadMode === "activated";
          return {
            activated,
            previousVersion: snapshot.version,
            activeVersion: snapshot.version,
            riskIncrease: false,
            result: activated ? ("activated" as const) : ("failed" as const),
            ...(activated ? {} : { failureCode: "policy_invalid" as const })
          };
        }
      },
      statePaths: paths,
      mutation: {
        async apply(operation) {
          operations.push(operation);
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
      secureCookies: false,
      productInfo: {
        version: "1.2.3",
        buildCommit: "abc123",
        stateRoot: root,
        ownerPassphraseFile: paths.ownerPassphraseFile
      }
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
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    cleanup.push(
      () =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        })
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("test listener unavailable");
    const origin = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${origin}/owner/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "owner passphrase test value" })
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure;");
    const { csrf } = (await login.json()) as { csrf: string };

    const state = await fetch(`${origin}/owner/api/state`, {
      headers: { cookie }
    });
    expect(await state.json()).toMatchObject({
      authorityMode: "restricted",
      product: {
        version: "1.2.3",
        buildCommit: "abc123",
        stateRoot: root
      }
    });

    const authority = await fetch(`${origin}/owner/api/authority`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ authorityMode: "autonomous" })
    });
    expect(authority.status).toBe(200);
    expect(operations).toEqual([{ kind: "set-authority-mode", authorityMode: "autonomous" }]);

    const priorCommands = await readFile(paths.commandCatalogFile, "utf8");
    const candidateCommands = JSON.stringify({ shell: { allowlist: { added: ["node"] } } });
    commandReloadMode = "failed";
    const rejectedCommands = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(rejectedCommands.status).toBe(409);
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(priorCommands);

    commandReloadMode = "throw";
    const crashedReload = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(crashedReload.status).toBe(500);
    expect(await crashedReload.json()).toMatchObject({
      error: { code: "commands_reload_failed" }
    });
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(priorCommands);

    const invalidBefore = await readFile(paths.commandCatalogFile, "utf8");
    const invalidCommands = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ content: "{" })
    });
    expect(invalidCommands.status).toBe(400);
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(invalidBefore);

    await rm(paths.commandCatalogFile, { force: true });
    commandReloadMode = "failed";
    const absentRejected = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(absentRejected.status).toBe(409);
    await expect(readFile(paths.commandCatalogFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await writeFile(paths.commandCatalogFile, priorCommands, "utf8");

    commandReloadMode = "activated";
    const acceptedCommands = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": csrf
      },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(acceptedCommands.status).toBe(200);
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(candidateCommands);

    let releaseReload!: () => void;
    commandReloadGate = new Promise<void>((resolvePromise) => {
      releaseReload = resolvePromise;
    });
    const callsBeforeConcurrent = commandReloadCalls;
    const firstConcurrentContent = JSON.stringify({ shell: { allowlist: { added: ["node"] } } });
    const secondConcurrentContent = JSON.stringify({
      shell: { allowlist: { added: ["node", "git"] } }
    });
    const firstConcurrent = fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ content: firstConcurrentContent })
    });
    while (commandReloadCalls === callsBeforeConcurrent) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    const secondConcurrent = fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ content: secondConcurrentContent })
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(commandReloadCalls).toBe(callsBeforeConcurrent + 1);
    commandReloadGate = undefined;
    releaseReload();
    const [firstConcurrentResponse, secondConcurrentResponse] = await Promise.all([
      firstConcurrent,
      secondConcurrent
    ]);
    expect(firstConcurrentResponse.status).toBe(200);
    expect(secondConcurrentResponse.status).toBe(200);
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(secondConcurrentContent);

    await rm(root, { recursive: true, force: true });
    await writeFile(root, "not-a-directory", "utf8");
    const writeFailure = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(writeFailure.status).toBe(500);
    expect(await readFile(root, "utf8")).toBe("not-a-directory");

    await rm(root, { force: true });
    await mkdir(root, { recursive: true });
    await writeFile(paths.commandCatalogFile, priorCommands, "utf8");
    commandReloadMode = "recovery-fail";
    const recoveryFailure = await fetch(`${origin}/owner/api/commands`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ content: candidateCommands })
    });
    expect(recoveryFailure.status).toBe(500);
    expect(await recoveryFailure.json()).toMatchObject({
      error: { code: "commands_recovery_failed" }
    });
  });
});
