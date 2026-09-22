/** Debate application service with bounded event-driven waits. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DebateError } from "./errors.js";
import { DebateStore } from "./store.js";
import type {
  DebateCreateInput,
  DebateCreateResult,
  DebateJoinInput,
  DebateJoinResult,
  DebateListItem,
  DebateMemberAuth,
  DebateReadInput,
  DebateSendInput,
  DebateSendResult,
  DebateService,
  DebateServiceOptions,
  DebateSnapshot,
  DebateStopInput,
  DebateWaitInput,
  DebateWaitResult
} from "./types.js";
import { DebateWaiterRegistry } from "./waiters.js";

export const DEFAULT_DEBATE_PICKUP_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_DEBATE_RESPONSE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_DEBATE_REQUEST_WAIT_MS = 20_000;
export const MAX_DEBATE_REQUEST_WAIT_MS = 25_000;
export const MIN_DEBATE_TURNS = 3;
export const MAX_DEBATE_TURNS = 64;

const MAX_TOPIC_CHARS = 4_096;
const MAX_NICKNAME_CHARS = 80;
const MAX_CONNECTION_ID_CHARS = 256;
const MAX_ID_CHARS = 256;
const MAX_CLIENT_MESSAGE_ID_CHARS = 128;
const MAX_MESSAGE_CHARS = 65_536;

function invalid(message: string): never {
  throw new DebateError("invalid_input", message);
}

function boundedText(value: string, name: string, maxChars: number, trim = true): string {
  if (typeof value !== "string") invalid(`${name} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < 1 || normalized.length > maxChars) {
    invalid(`${name} must contain between 1 and ${maxChars} characters`);
  }
  return normalized;
}

function safeInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveDuration(value: number, name: string, max: number): number {
  return safeInteger(value, name, 1, max);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function membershipCredential(): string {
  return randomBytes(32).toString("base64url");
}

function validateAuth(auth: DebateMemberAuth): DebateMemberAuth {
  return {
    debateId: boundedText(auth.debateId, "debateId", MAX_ID_CHARS),
    participantId: boundedText(auth.participantId, "participantId", MAX_ID_CHARS),
    membershipCredential: boundedText(
      auth.membershipCredential,
      "membershipCredential",
      MAX_ID_CHARS
    ),
    connectionId: boundedText(auth.connectionId, "connectionId", MAX_CONNECTION_ID_CHARS)
  };
}

function requestWaitDuration(input: number | undefined, configured: number): number {
  if (input === undefined) return configured;
  return safeInteger(input, "maxWaitMs", 1, configured);
}

function waitActionable(
  debate: DebateSnapshot,
  participantId: string,
  afterSequence: number
): boolean {
  if (debate.sequence > afterSequence) return true;
  if (debate.status === "waiting") return false;
  if (debate.status !== "active") return true;
  return debate.currentParticipantId === participantId;
}

function durableWaitRemaining(debate: DebateSnapshot, nowMs: number): number | undefined {
  if (debate.status !== "active") return undefined;
  const deadline =
    debate.turnAcknowledgedAt === null ? debate.pickupDeadlineAt : debate.responseDeadlineAt;
  if (deadline === null) return undefined;
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - nowMs);
}

async function awaitRegistration(
  promise: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<"notified" | "timeout"> {
  if (signal?.aborted === true) {
    throw new DebateError("wait_cancelled", "Debate wait was cancelled");
  }
  return await new Promise<"notified" | "timeout">((resolve, reject) => {
    let settled = false;
    const finish = (result: "notified" | "timeout"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DebateError("wait_cancelled", "Debate wait was cancelled"));
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => finish("notified"));
  });
}

export function createDebateService(
  path: string,
  options: DebateServiceOptions = {}
): DebateService {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const pickupTimeoutMs = positiveDuration(
    options.pickupTimeoutMs ?? DEFAULT_DEBATE_PICKUP_TIMEOUT_MS,
    "pickupTimeoutMs",
    24 * 60 * 60_000
  );
  const responseTimeoutMs = positiveDuration(
    options.responseTimeoutMs ?? DEFAULT_DEBATE_RESPONSE_TIMEOUT_MS,
    "responseTimeoutMs",
    24 * 60 * 60_000
  );
  const requestWaitMs = positiveDuration(
    options.requestWaitMs ?? DEFAULT_DEBATE_REQUEST_WAIT_MS,
    "requestWaitMs",
    MAX_DEBATE_REQUEST_WAIT_MS
  );
  const store = new DebateStore(path);
  const waiters = new DebateWaiterRegistry();
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new DebateError("debate_store_closed", "Debate service is closed");
  };

  const read = (input: Readonly<DebateReadInput>): DebateSnapshot => {
    ensureOpen();
    const auth = validateAuth(input.auth);
    const afterSequence =
      input.afterSequence === undefined
        ? undefined
        : safeInteger(input.afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
    const nowMs = now();
    const result = store.readMember({
      auth,
      membershipHash: digest(auth.membershipCredential),
      nowMs,
      now: iso(nowMs),
      responseDeadlineAt: iso(nowMs + responseTimeoutMs),
      ...(afterSequence === undefined ? {} : { afterSequence })
    });
    if (result.changed) waiters.notify(auth.debateId);
    return result.debate;
  };

  const service: DebateService = {
    create(input: Readonly<DebateCreateInput>): DebateCreateResult {
      ensureOpen();
      const topic = boundedText(input.topic, "topic", MAX_TOPIC_CHARS);
      const nickname = boundedText(input.nickname, "nickname", MAX_NICKNAME_CHARS);
      const connectionId = boundedText(input.connectionId, "connectionId", MAX_CONNECTION_ID_CHARS);
      const maxTurns = safeInteger(input.maxTurns, "maxTurns", MIN_DEBATE_TURNS, MAX_DEBATE_TURNS);
      if (input.finalizerRole !== "creator" && input.finalizerRole !== "joiner") {
        invalid("finalizerRole must be creator or joiner");
      }
      const debateId = boundedText(id(), "generated debateId", MAX_ID_CHARS);
      const participantId = boundedText(id(), "generated participantId", MAX_ID_CHARS);
      const credential = membershipCredential();
      const nowIso = iso(now());
      const debate = store.create({
        debateId,
        participantId,
        topic,
        nickname,
        connectionId,
        membershipHash: digest(credential),
        maxTurns,
        finalizerRole: input.finalizerRole,
        now: nowIso
      });
      return Object.freeze({
        debate,
        membership: Object.freeze({ participantId, membershipCredential: credential })
      });
    },

    join(input: Readonly<DebateJoinInput>): DebateJoinResult {
      ensureOpen();
      const debateId = boundedText(input.debateId, "debateId", MAX_ID_CHARS);
      const nickname = boundedText(input.nickname, "nickname", MAX_NICKNAME_CHARS);
      const connectionId = boundedText(input.connectionId, "connectionId", MAX_CONNECTION_ID_CHARS);
      const participantId = boundedText(id(), "generated participantId", MAX_ID_CHARS);
      const credential = membershipCredential();
      const nowMs = now();
      const debate = store.join({
        debateId,
        participantId,
        nickname,
        connectionId,
        membershipHash: digest(credential),
        now: iso(nowMs),
        pickupDeadlineAt: iso(nowMs + pickupTimeoutMs)
      });
      waiters.notify(debateId);
      return Object.freeze({
        debate,
        membership: Object.freeze({ participantId, membershipCredential: credential })
      });
    },

    read,

    send(input: Readonly<DebateSendInput>): DebateSendResult {
      ensureOpen();
      const auth = validateAuth(input.auth);
      const expectedSequence = safeInteger(
        input.expectedSequence,
        "expectedSequence",
        0,
        Number.MAX_SAFE_INTEGER
      );
      const expectedTurnParticipantId = boundedText(
        input.expectedTurnParticipantId,
        "expectedTurnParticipantId",
        MAX_ID_CHARS
      );
      const clientMessageId = boundedText(
        input.clientMessageId,
        "clientMessageId",
        MAX_CLIENT_MESSAGE_ID_CHARS
      );
      const content = boundedText(input.content, "content", MAX_MESSAGE_CHARS, false);
      if (content.trim().length === 0) invalid("content must not be blank");
      const nowMs = now();
      const result = store.send({
        auth,
        membershipHash: digest(auth.membershipCredential),
        expectedSequence,
        expectedTurnParticipantId,
        clientMessageId,
        content,
        contentHash: digest(content),
        nowMs,
        now: iso(nowMs),
        nextPickupDeadlineAt: iso(nowMs + pickupTimeoutMs)
      });
      if (!result.idempotentReplay) waiters.notify(auth.debateId);
      return result;
    },

    async wait(input: Readonly<DebateWaitInput>): Promise<DebateWaitResult> {
      ensureOpen();
      const auth = validateAuth(input.auth);
      const afterSequence = safeInteger(
        input.afterSequence,
        "afterSequence",
        0,
        Number.MAX_SAFE_INTEGER
      );
      const maxWaitMs = requestWaitDuration(input.maxWaitMs, requestWaitMs);
      const requestDeadline = Date.now() + maxWaitMs;

      let debate = read({ auth, afterSequence });
      if (waitActionable(debate, auth.participantId, afterSequence)) {
        return Object.freeze({ debate, timedOut: false });
      }

      while (true) {
        if (input.signal?.aborted === true) {
          throw new DebateError("wait_cancelled", "Debate wait was cancelled");
        }
        const requestRemaining = requestDeadline - Date.now();
        if (requestRemaining <= 0) return Object.freeze({ debate, timedOut: true });

        const registration = waiters.register(auth.debateId);
        try {
          // Lost-wakeup protection: state is checked again only after registration exists.
          debate = read({ auth, afterSequence });
          if (waitActionable(debate, auth.participantId, afterSequence)) {
            return Object.freeze({ debate, timedOut: false });
          }

          const durableRemaining = durableWaitRemaining(debate, now());
          const sleepMs = Math.max(
            1,
            Math.min(
              requestDeadline - Date.now(),
              durableRemaining === undefined ? Number.MAX_SAFE_INTEGER : durableRemaining + 1
            )
          );
          await awaitRegistration(registration.promise, sleepMs, input.signal);
        } finally {
          registration.cancel();
        }

        debate = read({ auth, afterSequence });
        if (waitActionable(debate, auth.participantId, afterSequence)) {
          return Object.freeze({ debate, timedOut: false });
        }
        if (Date.now() >= requestDeadline) return Object.freeze({ debate, timedOut: true });
      }
    },

    stop(input: Readonly<DebateStopInput>): DebateSnapshot {
      ensureOpen();
      const auth = validateAuth(input.auth);
      const nowMs = now();
      const debate = store.stopMember({
        auth,
        membershipHash: digest(auth.membershipCredential),
        nowMs,
        now: iso(nowMs)
      });
      waiters.notify(auth.debateId);
      return debate;
    },

    listForOwner(limit = 100): readonly DebateListItem[] {
      ensureOpen();
      const safeLimit = safeInteger(limit, "limit", 1, 200);
      const nowMs = now();
      return store.ownerList(nowMs, iso(nowMs), safeLimit);
    },

    readForOwner(debateId: string, afterSequence?: number): DebateSnapshot {
      ensureOpen();
      const safeDebateId = boundedText(debateId, "debateId", MAX_ID_CHARS);
      const safeAfter =
        afterSequence === undefined
          ? undefined
          : safeInteger(afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
      const nowMs = now();
      return store.ownerRead(
        safeDebateId,
        nowMs,
        iso(nowMs),
        ...(safeAfter === undefined ? [] : [safeAfter])
      );
    },

    stopAsOwner(debateId: string): DebateSnapshot {
      ensureOpen();
      const safeDebateId = boundedText(debateId, "debateId", MAX_ID_CHARS);
      const nowMs = now();
      const debate = store.ownerStop(safeDebateId, nowMs, iso(nowMs));
      waiters.notify(safeDebateId);
      return debate;
    },

    resumeAsOwner(debateId: string): DebateSnapshot {
      ensureOpen();
      const safeDebateId = boundedText(debateId, "debateId", MAX_ID_CHARS);
      const nowMs = now();
      const debate = store.ownerResume(
        safeDebateId,
        nowMs,
        iso(nowMs),
        iso(nowMs + pickupTimeoutMs)
      );
      waiters.notify(safeDebateId);
      return debate;
    },

    close(): void {
      if (closed) return;
      closed = true;
      waiters.close();
      store.close();
    }
  };

  return Object.freeze(service);
}
