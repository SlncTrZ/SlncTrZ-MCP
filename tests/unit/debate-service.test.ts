import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDebateService,
  type DebateError,
  type DebateMemberAuth
} from "../../src/debate/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function databasePath(prefix = "slnctrz-debate-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "debate.sqlite3");
}

function auth(
  debateId: string,
  participantId: string,
  membershipCredential: string,
  connectionId: string
): DebateMemberAuth {
  return { debateId, participantId, membershipCredential, connectionId };
}

function expectDebateError(operation: () => unknown, code: DebateError["code"]): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

async function bundleDebateServiceForWorker(path: string): Promise<string> {
  const outfile = join(dirname(path), "debate-service-worker.mjs");
  await build({
    entryPoints: [join(process.cwd(), "src/debate/service.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent"
  });
  return pathToFileURL(outfile).href;
}

describe("durable Debate service", () => {
  it("creates and joins exactly two connection-bound participants without persisting membership plaintext", async () => {
    const path = await databasePath();
    const service = createDebateService(path, {
      id: (() => {
        const ids = ["debate-1", "participant-a", "participant-b"];
        return () => ids.shift() ?? "unexpected-id";
      })()
    });

    const created = service.create({
      topic: "Should the gateway use durable turn state?",
      nickname: "Alpha",
      connectionId: "grant-a",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    expect(created.debate.status).toBe("waiting");
    expect(created.debate.participants).toEqual([
      expect.objectContaining({
        participantId: "participant-a",
        nickname: "Alpha",
        role: "creator"
      })
    ]);

    expectDebateError(
      () =>
        service.join({
          debateId: created.debate.debateId,
          nickname: "Same grant",
          connectionId: "grant-a"
        }),
      "same_connection_not_allowed"
    );

    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Alpha",
      connectionId: "grant-b"
    });
    expect(joined.debate.status).toBe("active");
    expect(joined.debate.currentParticipantId).toBe("participant-a");
    expect(joined.debate.participants.map((participant) => participant.nickname)).toEqual([
      "Alpha",
      "Alpha"
    ]);

    const creatorAuth = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-a"
    );
    expect(service.read({ auth: creatorAuth }).currentParticipantId).toBe("participant-a");
    expectDebateError(
      () => service.read({ auth: { ...creatorAuth, connectionId: "grant-b" } }),
      "membership_invalid"
    );
    expectDebateError(
      () => service.read({ auth: { ...creatorAuth, membershipCredential: "wrong-credential" } }),
      "membership_invalid"
    );

    const raw = await readFile(path);
    expect(raw.includes(Buffer.from(created.membership.membershipCredential))).toBe(false);
    expect(raw.includes(Buffer.from(joined.membership.membershipCredential))).toBe(false);

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    service.close();
  });

  it("persists transcript, sequence, deadlines and stopped state across restart", async () => {
    const path = await databasePath("slnctrz-debate-restart-");
    let now = Date.parse("2026-09-20T10:00:00.000Z");
    const ids = ["debate-r", "participant-r1", "participant-r2"];
    const first = createDebateService(path, {
      now: () => now,
      id: () => ids.shift() ?? "unexpected-id",
      pickupTimeoutMs: 60_000,
      responseTimeoutMs: 15 * 60_000
    });
    const created = first.create({
      topic: "Restart durability",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "joiner"
    });
    const joined = first.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const creatorAuth = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );

    const acknowledged = first.read({ auth: creatorAuth });
    expect(acknowledged.turnAcknowledgedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(acknowledged.responseDeadlineAt).toBe("2026-09-20T10:15:00.000Z");

    first.send({
      auth: creatorAuth,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-r1",
      content: "Persist this turn."
    });
    first.close();

    now += 5_000;
    const restarted = createDebateService(path, {
      now: () => now,
      pickupTimeoutMs: 60_000,
      responseTimeoutMs: 15 * 60_000
    });
    const joinerAuth = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    const afterRestart = restarted.read({ auth: joinerAuth });
    expect(afterRestart.sequence).toBe(1);
    expect(afterRestart.messages).toEqual([
      expect.objectContaining({
        sequence: 1,
        participantId: created.membership.participantId,
        nickname: "One",
        content: "Persist this turn."
      })
    ]);
    expect(afterRestart.turnAssignedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(afterRestart.turnAcknowledgedAt).toBe("2026-09-20T10:00:05.000Z");
    expect(restarted.listForOwner()).toEqual([
      expect.objectContaining({
        debateId: created.debate.debateId,
        status: "active",
        sequence: 1
      })
    ]);
    expect(restarted.readForOwner(created.debate.debateId, 1).messages).toEqual([]);

    const stopped = restarted.stop({ auth: joinerAuth });
    expect(stopped.status).toBe("stopped");
    restarted.close();

    const secondRestart = createDebateService(path, { now: () => now });
    expect(secondRestart.read({ auth: creatorAuth }).status).toBe("stopped");
    secondRestart.close();

    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    database.close();
  });

  it("enforces expected sequence and turn while making clientMessageId retries idempotent", async () => {
    const path = await databasePath("slnctrz-debate-idempotency-");
    const ids = ["debate-i", "participant-i1", "participant-i2"];
    const service = createDebateService(path, { id: () => ids.shift() ?? "unexpected-id" });
    const created = service.create({
      topic: "Idempotency",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const creatorAuth = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const joinerAuth = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    service.read({ auth: creatorAuth });

    expectDebateError(
      () =>
        service.send({
          auth: creatorAuth,
          expectedSequence: 9,
          expectedTurnParticipantId: created.membership.participantId,
          clientMessageId: "msg-i1",
          content: "hello"
        }),
      "sequence_conflict"
    );

    expectDebateError(
      () =>
        service.send({
          auth: creatorAuth,
          expectedSequence: 0,
          expectedTurnParticipantId: "somebody-else",
          clientMessageId: "msg-i1",
          content: "hello"
        }),
      "turn_conflict"
    );

    const first = service.send({
      auth: creatorAuth,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-i1",
      content: "hello"
    });
    expect(first.idempotentReplay).toBe(false);
    expect(first.debate.sequence).toBe(1);

    const replay = service.send({
      auth: creatorAuth,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-i1",
      content: "hello"
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.debate.sequence).toBe(1);

    service.read({ auth: joinerAuth });
    service.send({
      auth: joinerAuth,
      expectedSequence: 1,
      expectedTurnParticipantId: joined.membership.participantId,
      clientMessageId: "msg-i2",
      content: "advance the debate"
    });

    const replayAfterAdvance = service.send({
      auth: creatorAuth,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-i1",
      content: "hello"
    });
    expect(replayAfterAdvance.idempotentReplay).toBe(true);
    expect(replayAfterAdvance.message).toEqual(first.message);
    expect(replayAfterAdvance.debate).toEqual(first.debate);

    expectDebateError(
      () =>
        service.send({
          auth: creatorAuth,
          expectedSequence: 1,
          expectedTurnParticipantId: created.membership.participantId,
          clientMessageId: "msg-i1",
          content: "hello"
        }),
      "idempotency_conflict"
    );
    expectDebateError(
      () =>
        service.send({
          auth: creatorAuth,
          expectedSequence: 0,
          expectedTurnParticipantId: "participant-i2",
          clientMessageId: "msg-i1",
          content: "hello"
        }),
      "idempotency_conflict"
    );
    expect(service.read({ auth: creatorAuth })).toMatchObject({
      sequence: 2,
      messages: [
        expect.objectContaining({ clientMessageId: "msg-i1", content: "hello" }),
        expect.objectContaining({ clientMessageId: "msg-i2", content: "advance the debate" })
      ]
    });

    expectDebateError(
      () =>
        service.send({
          auth: creatorAuth,
          expectedSequence: 0,
          expectedTurnParticipantId: created.membership.participantId,
          clientMessageId: "msg-i1",
          content: "different"
        }),
      "idempotency_conflict"
    );

    service.close();
  });

  it("reserves the final turn for the configured finalizer instead of deriving it from parity", async () => {
    const path = await databasePath("slnctrz-debate-finalizer-");
    const ids = ["debate-f", "participant-f1", "participant-f2"];
    const service = createDebateService(path, { id: () => ids.shift() ?? "unexpected-id" });
    const created = service.create({
      topic: "Finalizer reservation",
      nickname: "Creator",
      connectionId: "grant-1",
      maxTurns: 5,
      finalizerRole: "joiner"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Joiner",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );

    const turns = [
      [a, created.membership.participantId, "m1"],
      [b, joined.membership.participantId, "m2"],
      [a, created.membership.participantId, "m3"],
      [b, joined.membership.participantId, "m4"],
      [b, joined.membership.participantId, "summary"]
    ] as const;

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turn === undefined) throw new Error("missing test turn");
      const [member, expectedTurnParticipantId, content] = turn;
      service.read({ auth: member });
      const result = service.send({
        auth: member,
        expectedSequence: index,
        expectedTurnParticipantId,
        clientMessageId: `msg-f${index + 1}`,
        content
      });
      if (index === 3) {
        expect(result.debate.currentParticipantId).toBe(joined.membership.participantId);
      }
    }

    const completed = service.read({ auth: a });
    expect(completed.status).toBe("completed");
    expect(completed.completedTurns).toBe(5);
    expect(completed.messages.at(-1)).toMatchObject({
      participantId: joined.membership.participantId,
      isFinal: true,
      content: "summary"
    });
    service.close();
  });

  it("persists pickup/ack/response deadlines, never resets acknowledged deadlines, and pauses on timeout", async () => {
    const path = await databasePath("slnctrz-debate-deadline-");
    let now = Date.parse("2026-09-20T12:00:00.000Z");
    const ids = ["debate-d", "participant-d1", "participant-d2"];
    const service = createDebateService(path, {
      now: () => now,
      id: () => ids.shift() ?? "unexpected-id",
      pickupTimeoutMs: 30_000,
      responseTimeoutMs: 60_000
    });
    const created = service.create({
      topic: "Deadline semantics",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );

    const firstRead = service.read({ auth: a });
    expect(firstRead.turnAssignedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(firstRead.pickupDeadlineAt).toBe("2026-09-20T12:00:30.000Z");
    expect(firstRead.turnAcknowledgedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(firstRead.responseDeadlineAt).toBe("2026-09-20T12:01:00.000Z");

    now += 20_000;
    const retryRead = service.read({ auth: a });
    expect(retryRead.turnAcknowledgedAt).toBe(firstRead.turnAcknowledgedAt);
    expect(retryRead.responseDeadlineAt).toBe(firstRead.responseDeadlineAt);

    now = Date.parse("2026-09-20T12:01:00.001Z");
    expect(service.read({ auth: a })).toMatchObject({
      status: "paused_timeout",
      pauseReason: "response_timeout"
    });

    now += 10_000;
    const resumed = service.resumeAsOwner(created.debate.debateId);
    expect(resumed.status).toBe("active");
    expect(resumed.turnAcknowledgedAt).toBeNull();
    expect(resumed.responseDeadlineAt).toBeNull();
    expect(resumed.turnAssignedAt).toBe(new Date(now).toISOString());
    expect(resumed.pickupDeadlineAt).toBe(new Date(now + 30_000).toISOString());

    service.close();
  });

  it("pauses on a persisted pickup deadline when the assigned participant never acknowledges", async () => {
    const path = await databasePath("slnctrz-debate-pickup-");
    let now = Date.parse("2026-09-20T13:00:00.000Z");
    const ids = ["debate-p", "participant-p1", "participant-p2"];
    const service = createDebateService(path, {
      now: () => now,
      id: () => ids.shift() ?? "unexpected-id",
      pickupTimeoutMs: 30_000,
      responseTimeoutMs: 60_000
    });
    const created = service.create({
      topic: "Pickup timeout",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );

    const beforeDeadline = service.read({ auth: b });
    expect(beforeDeadline.status).toBe("active");
    expect(beforeDeadline.turnAcknowledgedAt).toBeNull();
    expect(beforeDeadline.pickupDeadlineAt).toBe("2026-09-20T13:00:30.000Z");

    now += 30_001;
    expect(service.read({ auth: b })).toMatchObject({
      status: "paused_timeout",
      pauseReason: "pickup_timeout",
      turnAcknowledgedAt: null,
      responseDeadlineAt: null
    });

    service.close();
  });

  it("uses event-driven bounded waits, wakes on early send, and cancellation never cancels the debate", async () => {
    const path = await databasePath("slnctrz-debate-wait-");
    const ids = ["debate-w", "participant-w1", "participant-w2"];
    const service = createDebateService(path, {
      id: () => ids.shift() ?? "unexpected-id",
      requestWaitMs: 250
    });
    const created = service.create({
      topic: "Wait semantics",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    service.read({ auth: a });

    const waiting = service.wait({ auth: b, afterSequence: 0, maxWaitMs: 200 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    service.send({
      auth: a,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-w1",
      content: "wake now"
    });
    const woken = await waiting;
    expect(woken.timedOut).toBe(false);
    expect(woken.debate.sequence).toBe(1);
    expect(woken.debate.currentParticipantId).toBe(joined.membership.participantId);
    expect(woken.debate.turnAcknowledgedAt).not.toBeNull();

    const controller = new AbortController();
    const cancelled = service.wait({
      auth: a,
      afterSequence: 1,
      maxWaitMs: 200,
      signal: controller.signal
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "wait_cancelled"
    } satisfies Partial<DebateError>);
    expect(service.read({ auth: a }).status).toBe("active");

    service.close();
  });

  it("loses only in-memory waiters across restart while preserving acknowledged deadlines", async () => {
    const path = await databasePath("slnctrz-debate-wait-restart-");
    let now = Date.parse("2026-09-20T14:00:00.000Z");
    const ids = ["debate-wr", "participant-wr1", "participant-wr2"];
    const first = createDebateService(path, {
      now: () => now,
      id: () => ids.shift() ?? "unexpected-id",
      pickupTimeoutMs: 30_000,
      responseTimeoutMs: 60_000,
      requestWaitMs: 200
    });
    const created = first.create({
      topic: "Wait restart durability",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = first.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );

    const acknowledged = first.read({ auth: a });
    expect(acknowledged.responseDeadlineAt).toBe("2026-09-20T14:01:00.000Z");

    const staleWait = first.wait({ auth: b, afterSequence: 0, maxWaitMs: 150 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    first.close();
    await expect(staleWait).rejects.toMatchObject({ code: "debate_store_closed" });

    now += 10_000;
    const restarted = createDebateService(path, {
      now: () => now,
      pickupTimeoutMs: 30_000,
      responseTimeoutMs: 60_000,
      requestWaitMs: 200
    });
    const afterRestart = restarted.read({ auth: a });
    expect(afterRestart).toMatchObject({
      status: "active",
      sequence: 0,
      turnAcknowledgedAt: "2026-09-20T14:00:00.000Z",
      responseDeadlineAt: "2026-09-20T14:01:00.000Z"
    });

    const freshWait = restarted.wait({ auth: b, afterSequence: 0, maxWaitMs: 150 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    restarted.send({
      auth: a,
      expectedSequence: 0,
      expectedTurnParticipantId: created.membership.participantId,
      clientMessageId: "msg-wr1",
      content: "continue after restart"
    });

    const continued = await freshWait;
    expect(continued.timedOut).toBe(false);
    expect(continued.debate).toMatchObject({
      status: "active",
      sequence: 1,
      currentParticipantId: joined.membership.participantId,
      turnAcknowledgedAt: "2026-09-20T14:00:10.000Z",
      responseDeadlineAt: "2026-09-20T14:01:10.000Z"
    });

    restarted.close();
  });

  it("wakes a bounded waiter immediately when a participant stops the debate", async () => {
    const path = await databasePath("slnctrz-debate-stop-wait-");
    const ids = ["debate-sw", "participant-sw1", "participant-sw2"];
    const service = createDebateService(path, {
      id: () => ids.shift() ?? "unexpected-id",
      requestWaitMs: 250
    });
    const created = service.create({
      topic: "Stop wakes waiters",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    service.read({ auth: a });

    const waiting = service.wait({ auth: b, afterSequence: 0, maxWaitMs: 200 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    service.stop({ auth: a });

    const woken = await waiting;
    expect(woken.timedOut).toBe(false);
    expect(woken.debate).toMatchObject({ status: "stopped", sequence: 0 });

    service.close();
  });

  it("serializes concurrent stop/send across independent SQLite handles without half-state", async () => {
    const path = await databasePath("slnctrz-debate-concurrent-race-");
    const ids = ["debate-cr", "participant-cr1", "participant-cr2"];
    const service = createDebateService(path, { id: () => ids.shift() ?? "unexpected-id" });
    const created = service.create({
      topic: "Concurrent stop/send race",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    service.read({ auth: a });

    const moduleUrl = await bundleDebateServiceForWorker(path);
    const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(gateBuffer);
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          const { createDebateService } = await import(workerData.moduleUrl);
          const service = createDebateService(workerData.path);
          const gate = new Int32Array(workerData.gateBuffer);
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
          while (Atomics.load(gate, 0) !== 2) Atomics.wait(gate, 0, 1);
          try {
            const result = service.send(workerData.input);
            parentPort.postMessage({ ok: true, result });
          } catch (error) {
            parentPort.postMessage({
              ok: false,
              code: error && typeof error === "object" ? error.code : undefined,
              message: error instanceof Error ? error.message : String(error)
            });
          } finally {
            service.close();
          }
        })().catch((error) => {
          parentPort.postMessage({ ok: false, code: "worker_failed", message: String(error) });
        });
      `,
      {
        eval: true,
        workerData: {
          moduleUrl,
          path,
          gateBuffer,
          input: {
            auth: a,
            expectedSequence: 0,
            expectedTurnParticipantId: created.membership.participantId,
            clientMessageId: "msg-concurrent",
            content: "race send"
          }
        }
      }
    );
    const workerOutcome = new Promise<
      | { readonly ok: true; readonly result: { readonly debate: { readonly sequence: number } } }
      | { readonly ok: false; readonly code?: string; readonly message: string }
    >((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });

    expect(Atomics.wait(gate, 0, 0, 2_000)).not.toBe("timed-out");
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);

    const stopped = service.stop({ auth: b });
    const outcome = await workerOutcome;
    await worker.terminate();

    const final = service.read({ auth: a });
    expect(stopped.status).toBe("stopped");
    expect(final.status).toBe("stopped");

    if (outcome.ok) {
      expect(outcome.result.debate.sequence).toBe(1);
      expect(final).toMatchObject({ sequence: 1, completedTurns: 1 });
      expect(final.messages).toEqual([
        expect.objectContaining({ clientMessageId: "msg-concurrent", content: "race send" })
      ]);
    } else {
      expect(outcome.code).toBe("debate_not_writable");
      expect(final).toMatchObject({ sequence: 0, completedTurns: 0 });
      expect(final.messages).toEqual([]);
    }

    service.close();
  });

  it("serializes stop/send outcomes without half-state", async () => {
    const path = await databasePath("slnctrz-debate-race-");
    const ids = ["debate-s", "participant-s1", "participant-s2"];
    const service = createDebateService(path, { id: () => ids.shift() ?? "unexpected-id" });
    const created = service.create({
      topic: "Stop race",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    const joined = service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );
    const b = auth(
      created.debate.debateId,
      joined.membership.participantId,
      joined.membership.membershipCredential,
      "grant-2"
    );
    service.read({ auth: a });

    expect(service.stop({ auth: b }).status).toBe("stopped");
    expectDebateError(
      () =>
        service.send({
          auth: a,
          expectedSequence: 0,
          expectedTurnParticipantId: created.membership.participantId,
          clientMessageId: "msg-after-stop",
          content: "must not commit"
        }),
      "debate_not_writable"
    );
    const stopped = service.read({ auth: a });
    expect(stopped.messages).toHaveLength(0);
    expect(stopped.sequence).toBe(0);

    service.close();
  });

  it("preserves a committed send when send wins before stop", async () => {
    const path = await databasePath("slnctrz-debate-send-stop-");
    const ids = ["debate-ss", "participant-ss1", "participant-ss2"];
    const service = createDebateService(path, { id: () => ids.shift() ?? "unexpected-id" });
    const created = service.create({
      topic: "Send then stop",
      nickname: "One",
      connectionId: "grant-1",
      maxTurns: 4,
      finalizerRole: "creator"
    });
    service.join({
      debateId: created.debate.debateId,
      nickname: "Two",
      connectionId: "grant-2"
    });
    const a = auth(
      created.debate.debateId,
      created.membership.participantId,
      created.membership.membershipCredential,
      "grant-1"
    );

    service.read({ auth: a });
    expect(
      service.send({
        auth: a,
        expectedSequence: 0,
        expectedTurnParticipantId: created.membership.participantId,
        clientMessageId: "msg-before-stop",
        content: "commit first"
      }).debate.sequence
    ).toBe(1);

    const stopped = service.stopAsOwner(created.debate.debateId);
    expect(stopped).toMatchObject({ status: "stopped", sequence: 1 });
    expect(stopped.messages).toEqual([
      expect.objectContaining({
        sequence: 1,
        clientMessageId: "msg-before-stop",
        content: "commit first"
      })
    ]);

    service.close();
  });
});
