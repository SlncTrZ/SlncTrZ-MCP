/** Durable SQLite persistence and transactional state machine for Debate. */

import { chmodSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";
import { DebateError } from "./errors.js";
import type {
  DebateListItem,
  DebateMemberAuth,
  DebateMessage,
  DebateParticipant,
  DebateParticipantRole,
  DebatePauseReason,
  DebateSendResult,
  DebateSnapshot,
  DebateStatus
} from "./types.js";

const SCHEMA_VERSION = 1;

interface DebateRow {
  readonly debate_id: string;
  readonly topic: string;
  readonly status: DebateStatus;
  readonly sequence: number;
  readonly max_turns: number;
  readonly completed_turns: number;
  readonly finalizer_role: DebateParticipantRole;
  readonly current_participant_id: string | null;
  readonly turn_assigned_at: string | null;
  readonly pickup_deadline_at: string | null;
  readonly turn_acknowledged_at: string | null;
  readonly response_deadline_at: string | null;
  readonly pause_reason: DebatePauseReason | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly stopped_at: string | null;
}

interface ParticipantRow {
  readonly participant_id: string;
  readonly debate_id: string;
  readonly role: DebateParticipantRole;
  readonly nickname: string;
  readonly connection_id: string;
  readonly membership_hash: string;
  readonly joined_at: string;
}

interface MessageRow {
  readonly sequence: number;
  readonly participant_id: string;
  readonly author_nickname: string;
  readonly client_message_id: string;
  readonly content: string;
  readonly content_hash: string;
  readonly is_final: number;
  readonly created_at: string;
}

interface MemberReadResult {
  readonly debate: DebateSnapshot;
  readonly changed: boolean;
}

interface CreateRecord {
  readonly debateId: string;
  readonly participantId: string;
  readonly topic: string;
  readonly nickname: string;
  readonly connectionId: string;
  readonly membershipHash: string;
  readonly maxTurns: number;
  readonly finalizerRole: DebateParticipantRole;
  readonly now: string;
}

interface JoinRecord {
  readonly debateId: string;
  readonly participantId: string;
  readonly nickname: string;
  readonly connectionId: string;
  readonly membershipHash: string;
  readonly now: string;
  readonly pickupDeadlineAt: string;
}

interface MemberReadRecord {
  readonly auth: DebateMemberAuth;
  readonly membershipHash: string;
  readonly nowMs: number;
  readonly now: string;
  readonly responseDeadlineAt: string;
  readonly afterSequence?: number;
}

interface SendRecord {
  readonly auth: DebateMemberAuth;
  readonly membershipHash: string;
  readonly expectedSequence: number;
  readonly expectedTurnParticipantId: string;
  readonly clientMessageId: string;
  readonly content: string;
  readonly contentHash: string;
  readonly nowMs: number;
  readonly now: string;
  readonly nextPickupDeadlineAt: string;
}

interface StopRecord {
  readonly auth: DebateMemberAuth;
  readonly membershipHash: string;
  readonly nowMs: number;
  readonly now: string;
}

function asParticipant(row: ParticipantRow): DebateParticipant {
  return Object.freeze({
    participantId: row.participant_id,
    nickname: row.nickname,
    role: row.role,
    joinedAt: row.joined_at
  });
}

function asMessage(row: MessageRow): DebateMessage {
  return Object.freeze({
    sequence: row.sequence,
    participantId: row.participant_id,
    nickname: row.author_nickname,
    clientMessageId: row.client_message_id,
    content: row.content,
    isFinal: row.is_final === 1,
    createdAt: row.created_at
  });
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export class DebateStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    ensureWindowsPrivateAcl(path, "file");
    this.#database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;"
    );
    this.#initializeSchema();
  }

  create(record: CreateRecord): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO debates (
             debate_id, topic, status, sequence, max_turns, completed_turns, finalizer_role,
             current_participant_id, turn_assigned_at, pickup_deadline_at, turn_acknowledged_at,
             response_deadline_at, pause_reason, created_at, updated_at, completed_at, stopped_at
           ) VALUES (?, ?, 'waiting', 0, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`
        )
        .run(
          record.debateId,
          record.topic,
          record.maxTurns,
          record.finalizerRole,
          record.now,
          record.now
        );
      this.#database
        .prepare(
          `INSERT INTO participants (
             participant_id, debate_id, role, nickname, connection_id, membership_hash, joined_at
           ) VALUES (?, ?, 'creator', ?, ?, ?, ?)`
        )
        .run(
          record.participantId,
          record.debateId,
          record.nickname,
          record.connectionId,
          record.membershipHash,
          record.now
        );
      return this.#snapshot(record.debateId);
    });
  }

  join(record: JoinRecord): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      const debate = this.#requireDebate(record.debateId);
      if (debate.status !== "waiting") {
        throw new DebateError("debate_already_joined", "Debate already has two participants");
      }
      const creator = this.#participantByRole(record.debateId, "creator");
      if (creator === undefined) {
        throw new DebateError("debate_invariant_failed", "Debate creator is missing");
      }
      if (creator.connection_id === record.connectionId) {
        throw new DebateError(
          "same_connection_not_allowed",
          "Debate participants must use distinct authenticated connections"
        );
      }
      this.#database
        .prepare(
          `INSERT INTO participants (
             participant_id, debate_id, role, nickname, connection_id, membership_hash, joined_at
           ) VALUES (?, ?, 'joiner', ?, ?, ?, ?)`
        )
        .run(
          record.participantId,
          record.debateId,
          record.nickname,
          record.connectionId,
          record.membershipHash,
          record.now
        );
      this.#database
        .prepare(
          `UPDATE debates
           SET status='active', current_participant_id=?, turn_assigned_at=?, pickup_deadline_at=?,
               turn_acknowledged_at=NULL, response_deadline_at=NULL, pause_reason=NULL, updated_at=?
           WHERE debate_id=?`
        )
        .run(
          creator.participant_id,
          record.now,
          record.pickupDeadlineAt,
          record.now,
          record.debateId
        );
      return this.#snapshot(record.debateId);
    });
  }

  readMember(record: MemberReadRecord): MemberReadResult {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#verifyMembership(record.auth, record.membershipHash);
      let changed = this.#expireIfDue(record.auth.debateId, record.nowMs, record.now);
      let debate = this.#requireDebate(record.auth.debateId);
      if (
        debate.status === "active" &&
        debate.current_participant_id === record.auth.participantId &&
        debate.turn_acknowledged_at === null
      ) {
        this.#database
          .prepare(
            `UPDATE debates
             SET turn_acknowledged_at=?, response_deadline_at=?, updated_at=?
             WHERE debate_id=? AND status='active' AND current_participant_id=?
               AND turn_acknowledged_at IS NULL`
          )
          .run(
            record.now,
            record.responseDeadlineAt,
            record.now,
            record.auth.debateId,
            record.auth.participantId
          );
        changed = true;
        debate = this.#requireDebate(record.auth.debateId);
      }
      return {
        debate: this.#snapshotFromRow(debate, record.afterSequence),
        changed
      };
    });
  }

  send(record: SendRecord): DebateSendResult {
    this.#assertOpen();
    return this.#transaction(() => {
      const participant = this.#verifyMembership(record.auth, record.membershipHash);
      this.#expireIfDue(record.auth.debateId, record.nowMs, record.now);

      const existing = this.#database
        .prepare(
          `SELECT sequence, participant_id, author_nickname, client_message_id, content,
                  content_hash, is_final, created_at
           FROM messages
           WHERE debate_id=? AND participant_id=? AND client_message_id=?`
        )
        .get(record.auth.debateId, record.auth.participantId, record.clientMessageId) as
        MessageRow | undefined;
      if (existing !== undefined) {
        const replayMatchesOriginalPayload =
          existing.content_hash === record.contentHash &&
          record.expectedSequence === existing.sequence - 1 &&
          record.expectedTurnParticipantId === existing.participant_id;
        if (!replayMatchesOriginalPayload) {
          throw new DebateError(
            "idempotency_conflict",
            "clientMessageId was already used with a different send payload"
          );
        }
        return Object.freeze({
          debate: this.#snapshot(record.auth.debateId),
          message: asMessage(existing),
          idempotentReplay: true
        });
      }

      const debate = this.#requireDebate(record.auth.debateId);
      if (debate.status !== "active") {
        throw new DebateError("debate_not_writable", "Debate is not active");
      }
      if (debate.sequence !== record.expectedSequence) {
        throw new DebateError("sequence_conflict", "Debate sequence has advanced");
      }
      if (
        debate.current_participant_id !== record.expectedTurnParticipantId ||
        debate.current_participant_id !== record.auth.participantId
      ) {
        throw new DebateError("turn_conflict", "Debate turn no longer belongs to this participant");
      }
      if (debate.turn_acknowledged_at === null || debate.response_deadline_at === null) {
        throw new DebateError(
          "turn_not_acknowledged",
          "Current turn must be received through debate.read or debate.wait before sending"
        );
      }

      const nextCompletedTurns = debate.completed_turns + 1;
      const isFinal = nextCompletedTurns === debate.max_turns;
      if (isFinal) {
        const finalizer = this.#participantByRole(record.auth.debateId, debate.finalizer_role);
        if (finalizer?.participant_id !== record.auth.participantId) {
          throw new DebateError(
            "debate_invariant_failed",
            "Final turn is not assigned to finalizer"
          );
        }
      }

      const nextSequence = debate.sequence + 1;
      this.#database
        .prepare(
          `INSERT INTO messages (
             debate_id, sequence, participant_id, author_nickname, client_message_id,
             content, content_hash, is_final, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.auth.debateId,
          nextSequence,
          record.auth.participantId,
          participant.nickname,
          record.clientMessageId,
          record.content,
          record.contentHash,
          isFinal ? 1 : 0,
          record.now
        );

      if (isFinal) {
        this.#database
          .prepare(
            `UPDATE debates
             SET status='completed', sequence=?, completed_turns=?, current_participant_id=NULL,
                 turn_assigned_at=NULL, pickup_deadline_at=NULL, turn_acknowledged_at=NULL,
                 response_deadline_at=NULL, pause_reason=NULL, completed_at=?, updated_at=?
             WHERE debate_id=?`
          )
          .run(nextSequence, nextCompletedTurns, record.now, record.now, record.auth.debateId);
      } else {
        const nextParticipant = this.#nextParticipant(
          record.auth.debateId,
          record.auth.participantId,
          debate.finalizer_role,
          nextCompletedTurns,
          debate.max_turns
        );
        this.#database
          .prepare(
            `UPDATE debates
             SET sequence=?, completed_turns=?, current_participant_id=?, turn_assigned_at=?,
                 pickup_deadline_at=?, turn_acknowledged_at=NULL, response_deadline_at=NULL,
                 pause_reason=NULL, updated_at=?
             WHERE debate_id=?`
          )
          .run(
            nextSequence,
            nextCompletedTurns,
            nextParticipant.participant_id,
            record.now,
            record.nextPickupDeadlineAt,
            record.now,
            record.auth.debateId
          );
      }

      const message = this.#database
        .prepare(
          `SELECT sequence, participant_id, author_nickname, client_message_id, content,
                  content_hash, is_final, created_at
           FROM messages WHERE debate_id=? AND sequence=?`
        )
        .get(record.auth.debateId, nextSequence) as MessageRow | undefined;
      if (message === undefined) {
        throw new DebateError("debate_invariant_failed", "Committed message is missing");
      }
      return Object.freeze({
        debate: this.#snapshot(record.auth.debateId),
        message: asMessage(message),
        idempotentReplay: false
      });
    });
  }

  stopMember(record: StopRecord): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#verifyMembership(record.auth, record.membershipHash);
      this.#expireIfDue(record.auth.debateId, record.nowMs, record.now);
      return this.#stop(record.auth.debateId, record.now);
    });
  }

  ownerRead(debateId: string, nowMs: number, now: string, afterSequence?: number): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#requireDebate(debateId);
      this.#expireIfDue(debateId, nowMs, now);
      return this.#snapshot(debateId, afterSequence);
    });
  }

  ownerList(nowMs: number, now: string, limit: number): readonly DebateListItem[] {
    this.#assertOpen();
    return this.#transaction(() => {
      const active = this.#database
        .prepare("SELECT debate_id FROM debates WHERE status='active'")
        .all() as { debate_id: string }[];
      for (const { debate_id } of active) this.#expireIfDue(debate_id, nowMs, now);
      const rows = this.#database
        .prepare("SELECT * FROM debates ORDER BY updated_at DESC, debate_id DESC LIMIT ?")
        .all(limit) as unknown as DebateRow[];
      return Object.freeze(
        rows.map((row) => {
          const snapshot = this.#snapshotFromRow(row, Number.MAX_SAFE_INTEGER);
          return Object.freeze({
            debateId: snapshot.debateId,
            topic: snapshot.topic,
            status: snapshot.status,
            sequence: snapshot.sequence,
            maxTurns: snapshot.maxTurns,
            completedTurns: snapshot.completedTurns,
            finalizerParticipantId: snapshot.finalizerParticipantId,
            currentParticipantId: snapshot.currentParticipantId,
            pickupDeadlineAt: snapshot.pickupDeadlineAt,
            responseDeadlineAt: snapshot.responseDeadlineAt,
            pauseReason: snapshot.pauseReason,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            completedAt: snapshot.completedAt,
            stoppedAt: snapshot.stoppedAt,
            participants: snapshot.participants
          } satisfies DebateListItem);
        })
      );
    });
  }

  ownerStop(debateId: string, nowMs: number, now: string): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#requireDebate(debateId);
      this.#expireIfDue(debateId, nowMs, now);
      return this.#stop(debateId, now);
    });
  }

  ownerResume(
    debateId: string,
    nowMs: number,
    now: string,
    pickupDeadlineAt: string
  ): DebateSnapshot {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#requireDebate(debateId);
      this.#expireIfDue(debateId, nowMs, now);
      const debate = this.#requireDebate(debateId);
      if (debate.status !== "paused_timeout" || debate.current_participant_id === null) {
        throw new DebateError("resume_not_allowed", "Only a timed-out Debate can be resumed");
      }
      this.#database
        .prepare(
          `UPDATE debates
           SET status='active', turn_assigned_at=?, pickup_deadline_at=?,
               turn_acknowledged_at=NULL, response_deadline_at=NULL, pause_reason=NULL, updated_at=?
           WHERE debate_id=?`
        )
        .run(now, pickupDeadlineAt, now, debateId);
      return this.#snapshot(debateId);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #initializeSchema(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new DebateError(
        "debate_schema_unsupported",
        `Debate schema version ${version} is newer than supported version ${SCHEMA_VERSION}`
      );
    }
    if (version === 0) {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS debates (
          debate_id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('waiting','active','paused_timeout','stopped','completed')),
          sequence INTEGER NOT NULL,
          max_turns INTEGER NOT NULL,
          completed_turns INTEGER NOT NULL,
          finalizer_role TEXT NOT NULL CHECK(finalizer_role IN ('creator','joiner')),
          current_participant_id TEXT,
          turn_assigned_at TEXT,
          pickup_deadline_at TEXT,
          turn_acknowledged_at TEXT,
          response_deadline_at TEXT,
          pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('pickup_timeout','response_timeout')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          stopped_at TEXT
        );
        CREATE TABLE IF NOT EXISTS participants (
          participant_id TEXT PRIMARY KEY,
          debate_id TEXT NOT NULL REFERENCES debates(debate_id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('creator','joiner')),
          nickname TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          membership_hash TEXT NOT NULL,
          joined_at TEXT NOT NULL,
          UNIQUE(debate_id, role),
          UNIQUE(debate_id, connection_id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          message_id INTEGER PRIMARY KEY AUTOINCREMENT,
          debate_id TEXT NOT NULL REFERENCES debates(debate_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          participant_id TEXT NOT NULL REFERENCES participants(participant_id),
          author_nickname TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          is_final INTEGER NOT NULL CHECK(is_final IN (0,1)),
          created_at TEXT NOT NULL,
          UNIQUE(debate_id, sequence),
          UNIQUE(debate_id, participant_id, client_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_debate_status_updated ON debates(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_debate_messages_sequence ON messages(debate_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_debate_participants_debate ON participants(debate_id);
        PRAGMA user_version=1;
      `);
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original state-machine or persistence error.
      }
      throw error;
    }
  }

  #requireDebate(debateId: string): DebateRow {
    const row = this.#database.prepare("SELECT * FROM debates WHERE debate_id=?").get(debateId) as
      DebateRow | undefined;
    if (row === undefined) throw new DebateError("debate_not_found", "Debate was not found");
    return row;
  }

  #participantByRole(debateId: string, role: DebateParticipantRole): ParticipantRow | undefined {
    return this.#database
      .prepare("SELECT * FROM participants WHERE debate_id=? AND role=?")
      .get(debateId, role) as ParticipantRow | undefined;
  }

  #verifyMembership(auth: DebateMemberAuth, membershipHash: string): ParticipantRow {
    const participant = this.#database
      .prepare("SELECT * FROM participants WHERE debate_id=? AND participant_id=?")
      .get(auth.debateId, auth.participantId) as ParticipantRow | undefined;
    if (
      participant === undefined ||
      participant.connection_id !== auth.connectionId ||
      !safeEqualHex(participant.membership_hash, membershipHash)
    ) {
      throw new DebateError("membership_invalid", "Debate membership is invalid");
    }
    return participant;
  }

  #expireIfDue(debateId: string, nowMs: number, now: string): boolean {
    const debate = this.#requireDebate(debateId);
    if (debate.status !== "active") return false;
    let pauseReason: DebatePauseReason | undefined;
    if (
      debate.turn_acknowledged_at === null &&
      debate.pickup_deadline_at !== null &&
      nowMs >= Date.parse(debate.pickup_deadline_at)
    ) {
      pauseReason = "pickup_timeout";
    } else if (
      debate.turn_acknowledged_at !== null &&
      debate.response_deadline_at !== null &&
      nowMs >= Date.parse(debate.response_deadline_at)
    ) {
      pauseReason = "response_timeout";
    }
    if (pauseReason === undefined) return false;
    this.#database
      .prepare(
        `UPDATE debates
         SET status='paused_timeout', pause_reason=?, updated_at=?
         WHERE debate_id=? AND status='active'`
      )
      .run(pauseReason, now, debateId);
    return true;
  }

  #stop(debateId: string, now: string): DebateSnapshot {
    const debate = this.#requireDebate(debateId);
    if (debate.status === "stopped") return this.#snapshotFromRow(debate);
    if (debate.status === "completed") {
      throw new DebateError("debate_not_writable", "Completed Debate cannot be stopped");
    }
    this.#database
      .prepare(
        `UPDATE debates
         SET status='stopped', current_participant_id=NULL, turn_assigned_at=NULL,
             pickup_deadline_at=NULL, turn_acknowledged_at=NULL, response_deadline_at=NULL,
             pause_reason=NULL, stopped_at=?, updated_at=?
         WHERE debate_id=?`
      )
      .run(now, now, debateId);
    return this.#snapshot(debateId);
  }

  #nextParticipant(
    debateId: string,
    currentParticipantId: string,
    finalizerRole: DebateParticipantRole,
    nextCompletedTurns: number,
    maxTurns: number
  ): ParticipantRow {
    if (nextCompletedTurns === maxTurns - 1) {
      const finalizer = this.#participantByRole(debateId, finalizerRole);
      if (finalizer === undefined) {
        throw new DebateError("debate_invariant_failed", "Debate finalizer is missing");
      }
      return finalizer;
    }
    const other = this.#database
      .prepare("SELECT * FROM participants WHERE debate_id=? AND participant_id<>? LIMIT 1")
      .get(debateId, currentParticipantId) as ParticipantRow | undefined;
    if (other === undefined) {
      throw new DebateError("debate_invariant_failed", "Other Debate participant is missing");
    }
    return other;
  }

  #snapshot(debateId: string, afterSequence?: number): DebateSnapshot {
    return this.#snapshotFromRow(this.#requireDebate(debateId), afterSequence);
  }

  #snapshotFromRow(row: DebateRow, afterSequence?: number): DebateSnapshot {
    const participants = (
      this.#database
        .prepare(
          `SELECT * FROM participants
           WHERE debate_id=?
           ORDER BY CASE role WHEN 'creator' THEN 0 ELSE 1 END, joined_at, participant_id`
        )
        .all(row.debate_id) as unknown as ParticipantRow[]
    ).map(asParticipant);
    const finalizerParticipantId =
      participants.find((participant) => participant.role === row.finalizer_role)?.participantId ??
      null;
    const threshold = afterSequence ?? 0;
    const messages = (
      this.#database
        .prepare(
          `SELECT sequence, participant_id, author_nickname, client_message_id, content,
                  content_hash, is_final, created_at
           FROM messages WHERE debate_id=? AND sequence>? ORDER BY sequence`
        )
        .all(row.debate_id, threshold) as unknown as MessageRow[]
    ).map(asMessage);
    return Object.freeze({
      debateId: row.debate_id,
      topic: row.topic,
      status: row.status,
      sequence: row.sequence,
      maxTurns: row.max_turns,
      completedTurns: row.completed_turns,
      finalizerRole: row.finalizer_role,
      finalizerParticipantId,
      currentParticipantId: row.current_participant_id,
      turnAssignedAt: row.turn_assigned_at,
      pickupDeadlineAt: row.pickup_deadline_at,
      turnAcknowledgedAt: row.turn_acknowledged_at,
      responseDeadlineAt: row.response_deadline_at,
      pauseReason: row.pause_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      stoppedAt: row.stopped_at,
      participants: Object.freeze(participants),
      messages: Object.freeze(messages)
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new DebateError("debate_store_closed", "Debate store is closed");
  }
}
