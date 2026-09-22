export { DebateError, type DebateErrorCode } from "./errors.js";
export {
  DEFAULT_DEBATE_PICKUP_TIMEOUT_MS,
  DEFAULT_DEBATE_REQUEST_WAIT_MS,
  DEFAULT_DEBATE_RESPONSE_TIMEOUT_MS,
  MAX_DEBATE_REQUEST_WAIT_MS,
  MAX_DEBATE_TURNS,
  MIN_DEBATE_TURNS,
  createDebateService
} from "./service.js";
export type {
  DebateCreateInput,
  DebateCreateResult,
  DebateJoinInput,
  DebateJoinResult,
  DebateListItem,
  DebateMemberAuth,
  DebateMembership,
  DebateMessage,
  DebateParticipant,
  DebateParticipantRole,
  DebatePauseReason,
  DebateReadInput,
  DebateSendInput,
  DebateSendResult,
  DebateService,
  DebateServiceOptions,
  DebateSnapshot,
  DebateStatus,
  DebateStopInput,
  DebateWaitInput,
  DebateWaitResult
} from "./types.js";
