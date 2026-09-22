/** Durable Debate public domain types. */

export type DebateStatus = "waiting" | "active" | "paused_timeout" | "stopped" | "completed";
export type DebateParticipantRole = "creator" | "joiner";
export type DebatePauseReason = "pickup_timeout" | "response_timeout";

export interface DebateParticipant {
  readonly participantId: string;
  readonly nickname: string;
  readonly role: DebateParticipantRole;
  readonly joinedAt: string;
}

export interface DebateMessage {
  readonly sequence: number;
  readonly participantId: string;
  readonly nickname: string;
  readonly clientMessageId: string;
  readonly content: string;
  readonly isFinal: boolean;
  readonly createdAt: string;
}

export interface DebateSnapshot {
  readonly debateId: string;
  readonly topic: string;
  readonly status: DebateStatus;
  readonly sequence: number;
  readonly maxTurns: number;
  readonly completedTurns: number;
  readonly finalizerRole: DebateParticipantRole;
  readonly finalizerParticipantId: string | null;
  readonly currentParticipantId: string | null;
  readonly turnAssignedAt: string | null;
  readonly pickupDeadlineAt: string | null;
  readonly turnAcknowledgedAt: string | null;
  readonly responseDeadlineAt: string | null;
  readonly pauseReason: DebatePauseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly stoppedAt: string | null;
  readonly participants: readonly DebateParticipant[];
  readonly messages: readonly DebateMessage[];
}

export interface DebateListItem {
  readonly debateId: string;
  readonly topic: string;
  readonly status: DebateStatus;
  readonly sequence: number;
  readonly maxTurns: number;
  readonly completedTurns: number;
  readonly finalizerParticipantId: string | null;
  readonly currentParticipantId: string | null;
  readonly pickupDeadlineAt: string | null;
  readonly responseDeadlineAt: string | null;
  readonly pauseReason: DebatePauseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly stoppedAt: string | null;
  readonly participants: readonly DebateParticipant[];
}

export interface DebateMembership {
  readonly participantId: string;
  readonly membershipCredential: string;
}

export interface DebateMemberAuth {
  readonly debateId: string;
  readonly participantId: string;
  readonly membershipCredential: string;
  readonly connectionId: string;
}

export interface DebateCreateInput {
  readonly topic: string;
  readonly nickname: string;
  readonly connectionId: string;
  readonly maxTurns: number;
  readonly finalizerRole: DebateParticipantRole;
}

export interface DebateJoinInput {
  readonly debateId: string;
  readonly nickname: string;
  readonly connectionId: string;
}

export interface DebateReadInput {
  readonly auth: DebateMemberAuth;
  readonly afterSequence?: number;
}

export interface DebateSendInput {
  readonly auth: DebateMemberAuth;
  readonly expectedSequence: number;
  readonly expectedTurnParticipantId: string;
  readonly clientMessageId: string;
  readonly content: string;
}

export interface DebateStopInput {
  readonly auth: DebateMemberAuth;
}

export interface DebateWaitInput {
  readonly auth: DebateMemberAuth;
  readonly afterSequence: number;
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
}

export interface DebateCreateResult {
  readonly debate: DebateSnapshot;
  readonly membership: DebateMembership;
}

export interface DebateJoinResult {
  readonly debate: DebateSnapshot;
  readonly membership: DebateMembership;
}

export interface DebateSendResult {
  readonly debate: DebateSnapshot;
  readonly message: DebateMessage;
  readonly idempotentReplay: boolean;
}

export interface DebateWaitResult {
  readonly debate: DebateSnapshot;
  readonly timedOut: boolean;
}

export interface DebateServiceOptions {
  readonly now?: () => number;
  readonly id?: () => string;
  readonly pickupTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly requestWaitMs?: number;
}

export interface DebateService {
  create(input: Readonly<DebateCreateInput>): DebateCreateResult;
  join(input: Readonly<DebateJoinInput>): DebateJoinResult;
  read(input: Readonly<DebateReadInput>): DebateSnapshot;
  send(input: Readonly<DebateSendInput>): DebateSendResult;
  wait(input: Readonly<DebateWaitInput>): Promise<DebateWaitResult>;
  stop(input: Readonly<DebateStopInput>): DebateSnapshot;
  listForOwner(limit?: number): readonly DebateListItem[];
  readForOwner(debateId: string, afterSequence?: number): DebateSnapshot;
  stopAsOwner(debateId: string): DebateSnapshot;
  resumeAsOwner(debateId: string): DebateSnapshot;
  deleteAsOwner(debateId: string): { readonly debateId: string };
  close(): void;
}
