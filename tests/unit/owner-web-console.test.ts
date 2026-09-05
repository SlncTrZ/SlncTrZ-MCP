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
    const web = createOwnerWebConsole({
      ownerSecretHash: createOwnerSecretHash("owner passphrase test value"),
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
      void web.handle(req, res, pathname).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
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
  });
});
