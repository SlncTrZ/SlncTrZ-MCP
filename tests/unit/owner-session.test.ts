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

const cleanup: (() => Promise<void>)[] = [];
const PASSPHRASE = "owner session policy test value";

interface Clock {
  value: number;
}

async function startOwner(clock: Clock): Promise<{ origin: string }> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-session-"));
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
    secureCookies: false,
    now: () => clock.value
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

async function session(origin: string, cookie: string): Promise<Response> {
  return fetch(`${origin}/owner/api/session`, { headers: { cookie } });
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("Owner Console session policy", () => {
  it("slides a three-hour idle window without crossing the twelve-hour absolute deadline", async () => {
    const start = Date.parse("2026-09-12T00:00:00.000Z");
    const clock = { value: start };
    const { origin } = await startOwner(clock);
    const auth = await login(origin);
    expect(auth.cookie).toContain("Max-Age=10800");

    clock.value = start + 2 * 60 * 60_000;
    let response = await session(origin, auth.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=10800");
    expect(await response.json()).toMatchObject({
      expiresAt: "2026-09-12T05:00:00.000Z",
      absoluteExpiresAt: "2026-09-12T12:00:00.000Z"
    });

    for (const hour of [4, 6, 8]) {
      clock.value = start + hour * 60 * 60_000;
      response = await session(origin, auth.cookie);
      expect(response.status).toBe(200);
    }

    clock.value = start + 10 * 60 * 60_000;
    response = await session(origin, auth.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=7200");
    expect(await response.json()).toMatchObject({
      expiresAt: "2026-09-12T12:00:00.000Z",
      absoluteExpiresAt: "2026-09-12T12:00:00.000Z"
    });

    clock.value = start + 11.5 * 60 * 60_000;
    response = await session(origin, auth.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=1800");

    clock.value = start + 12 * 60 * 60_000;
    expect((await session(origin, auth.cookie)).status).toBe(401);
  });

  it("signs out only the current Owner session", async () => {
    const start = Date.parse("2026-09-12T00:00:00.000Z");
    const clock = { value: start };
    const { origin } = await startOwner(clock);
    const first = await login(origin);
    const second = await login(origin);

    const logout = await fetch(`${origin}/owner/api/logout`, {
      method: "POST",
      headers: {
        cookie: second.cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": second.csrf
      },
      body: "{}"
    });
    expect(logout.status).toBe(200);
    expect((await session(origin, second.cookie)).status).toBe(401);
    expect((await session(origin, first.cookie)).status).toBe(200);
  });

  it("expires idle sessions, revokes logout immediately, and loses sessions across restart", async () => {
    const start = Date.parse("2026-09-12T00:00:00.000Z");
    const clock = { value: start };
    const first = await startOwner(clock);

    const idleAuth = await login(first.origin);
    clock.value = start + 3 * 60 * 60_000 + 1;
    expect((await session(first.origin, idleAuth.cookie)).status).toBe(401);

    clock.value = start + 4 * 60 * 60_000;
    const logoutAuth = await login(first.origin);
    const logout = await fetch(`${first.origin}/owner/api/logout`, {
      method: "POST",
      headers: {
        cookie: logoutAuth.cookie,
        "content-type": "application/json",
        "x-slnctrz-csrf": logoutAuth.csrf
      },
      body: "{}"
    });
    expect(logout.status).toBe(200);
    expect((await session(first.origin, logoutAuth.cookie)).status).toBe(401);

    clock.value = start + 5 * 60 * 60_000;
    const restartAuth = await login(first.origin);
    const second = await startOwner(clock);
    expect((await session(second.origin, restartAuth.cookie)).status).toBe(401);
  });
});
