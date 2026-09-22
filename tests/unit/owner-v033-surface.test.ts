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

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("Owner v0.3.3 connection and Debate surfaces", () => {
  it("serves /debate and manages profiles/debates only through an authenticated Owner session", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-v033-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const paths = managedStatePaths(root);
    await writeFile(
      paths.commandCatalogFile,
      JSON.stringify({ shell: { allowlist: { added: [] } } }),
      "utf8"
    );
    const snapshot = buildActivePolicySnapshot(
      await compilePolicyDocument({ schemaVersion: 2, paths: [root], authorityMode: "restricted" })
    );

    const profiles: { grantId: string; profile: "full" | "gateway-only" }[] = [];
    const defaults: { clientId: string; profile: "full" | "gateway-only" }[] = [];
    const ownerStops: string[] = [];
    const ownerResumes: string[] = [];
    const web = createOwnerWebConsole({
      ownerSecretHash: createOwnerSecretHash("owner v033 passphrase"),
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
      connections: {
        listConnections: () => [
          {
            grantId: "grant-1",
            connectionId: "grant-1",
            clientId: "client-1",
            resource: "https://gateway.test/mcp",
            scopes: ["mcp:tools"],
            surfaceProfile: "full" as const,
            createdAt: 1,
            lastSeenAt: 2,
            expiresAt: 99
          }
        ],
        setGrantProfile(grantId, profile) {
          profiles.push({ grantId, profile });
        },
        setClientDefault(clientId, profile) {
          defaults.push({ clientId, profile });
        }
      },
      debates: {
        listForOwner: () => [
          {
            debateId: "debate-1",
            topic: "Owner debate",
            status: "active" as const,
            sequence: 1,
            maxTurns: 4,
            completedTurns: 1,
            finalizerParticipantId: "p1",
            currentParticipantId: "p2",
            pickupDeadlineAt: null,
            responseDeadlineAt: "2026-09-20T15:30:00.000Z",
            pauseReason: null,
            createdAt: "2026-09-20T15:00:00.000Z",
            updatedAt: "2026-09-20T15:01:00.000Z",
            completedAt: null,
            stoppedAt: null,
            participants: []
          }
        ],
        readForOwner: (debateId, afterSequence) => ({
          debateId,
          topic: "Owner debate",
          status: "active" as const,
          sequence: 1,
          maxTurns: 4,
          completedTurns: 1,
          finalizerRole: "creator" as const,
          finalizerParticipantId: "p1",
          currentParticipantId: "p2",
          turnAssignedAt: "2026-09-20T15:01:00.000Z",
          pickupDeadlineAt: null,
          turnAcknowledgedAt: "2026-09-20T15:01:01.000Z",
          responseDeadlineAt: "2026-09-20T15:30:00.000Z",
          pauseReason: null,
          createdAt: "2026-09-20T15:00:00.000Z",
          updatedAt: "2026-09-20T15:01:00.000Z",
          completedAt: null,
          stoppedAt: null,
          participants: [],
          messages:
            afterSequence === 1
              ? []
              : [
                  {
                    sequence: 1,
                    participantId: "p1",
                    nickname: "Agent",
                    clientMessageId: "m1",
                    content: "First",
                    isFinal: false,
                    createdAt: "2026-09-20T15:01:00.000Z"
                  }
                ]
        }),
        stopAsOwner: (debateId) => {
          ownerStops.push(debateId);
          return {
            debateId,
            topic: "Owner debate",
            status: "stopped" as const,
            sequence: 1,
            maxTurns: 4,
            completedTurns: 1,
            finalizerRole: "creator" as const,
            finalizerParticipantId: "p1",
            currentParticipantId: null,
            turnAssignedAt: null,
            pickupDeadlineAt: null,
            turnAcknowledgedAt: null,
            responseDeadlineAt: null,
            pauseReason: null,
            createdAt: "2026-09-20T15:00:00.000Z",
            updatedAt: "2026-09-20T15:02:00.000Z",
            completedAt: null,
            stoppedAt: "2026-09-20T15:02:00.000Z",
            participants: [],
            messages: []
          };
        },
        resumeAsOwner: (debateId) => {
          ownerResumes.push(debateId);
          return {
            debateId,
            topic: "Owner debate",
            status: "active" as const,
            sequence: 1,
            maxTurns: 4,
            completedTurns: 1,
            finalizerRole: "creator" as const,
            finalizerParticipantId: "p1",
            currentParticipantId: "p2",
            turnAssignedAt: "2026-09-20T15:03:00.000Z",
            pickupDeadlineAt: "2026-09-20T15:05:00.000Z",
            turnAcknowledgedAt: null,
            responseDeadlineAt: null,
            pauseReason: null,
            createdAt: "2026-09-20T15:00:00.000Z",
            updatedAt: "2026-09-20T15:03:00.000Z",
            completedAt: null,
            stoppedAt: null,
            participants: [],
            messages: []
          };
        }
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing listener");
    const origin = `http://127.0.0.1:${address.port}`;

    const debatePage = await fetch(`${origin}/debate`);
    expect(debatePage.status).toBe(200);
    expect(await debatePage.text()).toContain(">Debate</");

    const ownerPage = await (await fetch(`${origin}/owner`)).text();
    expect(ownerPage).toContain('id="connections"');
    expect(ownerPage).toContain("/owner/api/connections/profile");
    expect(ownerPage).toContain("/owner/api/connections/default");
    expect(ownerPage).toContain('href="/debate"');

    expect((await fetch(`${origin}/owner/api/connections`)).status).toBe(401);
    expect((await fetch(`${origin}/owner/api/debates`)).status).toBe(401);

    const login = await fetch(`${origin}/owner/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "owner v033 passphrase" })
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    const { csrf } = (await login.json()) as { csrf: string };

    const connections = await fetch(`${origin}/owner/api/connections`, { headers: { cookie } });
    expect(await connections.json()).toEqual({
      connections: [
        expect.objectContaining({
          grantId: "grant-1",
          clientId: "client-1",
          surfaceProfile: "full"
        })
      ]
    });

    const profile = await fetch(`${origin}/owner/api/connections/profile`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ grantId: "grant-1", surfaceProfile: "gateway-only" })
    });
    expect(profile.status).toBe(200);
    expect(profiles).toEqual([{ grantId: "grant-1", profile: "gateway-only" }]);

    const clientDefault = await fetch(`${origin}/owner/api/connections/default`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: JSON.stringify({ clientId: "client-1", surfaceProfile: "full" })
    });
    expect(clientDefault.status).toBe(200);
    expect(defaults).toEqual([{ clientId: "client-1", profile: "full" }]);

    const debates = await fetch(`${origin}/owner/api/debates`, { headers: { cookie } });
    expect(await debates.json()).toEqual({
      debates: [expect.objectContaining({ debateId: "debate-1", status: "active" })]
    });

    const delta = await fetch(`${origin}/owner/api/debates/debate-1?afterSequence=1`, {
      headers: { cookie }
    });
    expect(await delta.json()).toMatchObject({ debateId: "debate-1", messages: [] });

    const stop = await fetch(`${origin}/owner/api/debates/debate-1/stop`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: "{}"
    });
    expect(stop.status).toBe(200);
    expect(ownerStops).toEqual(["debate-1"]);

    const resume = await fetch(`${origin}/owner/api/debates/debate-1/resume`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-slnctrz-csrf": csrf },
      body: "{}"
    });
    expect(resume.status).toBe(200);
    expect(ownerResumes).toEqual(["debate-1"]);
  });
});
