import { randomUUID } from "node:crypto"
import { DocumentConflictError, type DocumentStore } from "./document-store"
import {
  type PlanConflictError,
  type PlanValidationCode,
  type PlanValidationError,
  type PlanWriteInput,
  decodePlanWriteInput,
  planScope,
  planWriteCandidateHash,
} from "./plan-controller"

export const PLAN_EDIT_PROTOCOL_VERSION = 1 as const
export const PLAN_EDIT_CHALLENGE_TTL_MS = 15 * 60 * 1000

export type PlanEditCommand = {
  readonly protocol_version: typeof PLAN_EDIT_PROTOCOL_VERSION
  readonly activity_id: string
  readonly request_id: string
  readonly session_id: string
  readonly goal_id: string
  readonly admitted_at: string
  readonly candidate_hash: string
  readonly plan_write: PlanWriteInput
  readonly confirmed_challenge_id?: string
}

export type PlanEditChallenge = {
  readonly challenge_id: string
  readonly candidate_hash: string
  readonly expected_plan_id: string
  readonly expected_version: number
  readonly issued_at: string
  readonly expires_at: string
}

export type PlanEditFailure =
  | {
      readonly kind: "validation"
      readonly code: PlanValidationCode
      readonly offending_step_ids: readonly string[]
      readonly previous_plan_id: string | null
      readonly previous_plan_version: number | null
    }
  | {
      readonly kind: "conflict"
      readonly expected_plan_id: string | null
      readonly expected_version: number | null
      readonly actual_plan_id: string | null
      readonly actual_version: number | null
    }
  | { readonly kind: "target_unavailable"; readonly message: string }
  | { readonly kind: "runtime_error"; readonly message: string }

export type PlanEditReceipt = {
  readonly protocol_version: typeof PLAN_EDIT_PROTOCOL_VERSION
  readonly state: "challenged" | "queued" | "applied" | "rejected" | "conflict" | "runtime_error"
  readonly command: PlanEditCommand
  readonly updated_at: string
  readonly challenge?: PlanEditChallenge
  readonly result?: {
    readonly plan_id: string
    readonly doc_id: string
    readonly version: number
    readonly changed: boolean
  }
  readonly failure?: PlanEditFailure
}

export type PlanEditSettlement =
  | {
      readonly state: "applied"
      readonly result: NonNullable<PlanEditReceipt["result"]>
    }
  | { readonly state: "rejected" | "conflict" | "runtime_error"; readonly failure: PlanEditFailure }

export class PlanEditBusyError extends Error {
  readonly _tag = "PlanEditBusyError"
  override readonly name = "PlanEditBusyError"

  constructor(readonly activity_id: string) {
    super(`A plan edit is already queued: ${activity_id}`)
  }
}

export class PlanEditChallengeError extends Error {
  readonly _tag = "PlanEditChallengeError"
  override readonly name = "PlanEditChallengeError"

  constructor(readonly reason: "missing" | "mismatch" | "expired" | "consumed") {
    super(`Plan edit quality challenge is ${reason}`)
  }
}

export class PlanEditMailboxConflictError extends Error {
  readonly _tag = "PlanEditMailboxConflictError"
  override readonly name = "PlanEditMailboxConflictError"

  constructor() {
    super("Plan edit mailbox changed concurrently; reload the plan and retry")
  }
}

export class PlanEditRequestConflictError extends Error {
  readonly _tag = "PlanEditRequestConflictError"
  override readonly name = "PlanEditRequestConflictError"

  constructor(readonly request_id: string) {
    super(`Plan edit request id was already used with different content: ${request_id}`)
  }
}

export class PlanEditProtocolCorruptionError extends Error {
  readonly _tag = "PlanEditProtocolCorruptionError"
  override readonly name = "PlanEditProtocolCorruptionError"

  constructor(readonly doc_id: string) {
    super(`Plan edit mailbox is malformed: ${doc_id}`)
  }
}

export class PlanEditTargetUnavailableError extends Error {
  readonly _tag = "PlanEditTargetUnavailableError"
  override readonly name = "PlanEditTargetUnavailableError"

  constructor(readonly reason: string) {
    super(`Plan edit target is unavailable: ${reason}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

const isTimestamp = (value: unknown): value is string => isNonEmptyString(value) && Number.isFinite(Date.parse(value))

const PLAN_EDIT_STATES = new Set<PlanEditReceipt["state"]>([
  "challenged",
  "queued",
  "applied",
  "rejected",
  "conflict",
  "runtime_error",
])

const PLAN_VALIDATION_CODES = new Set<PlanValidationCode>([
  "invalid_operation",
  "invalid_precondition",
  "plan_already_exists",
  "plan_missing",
  "replan_reason_required",
  "invalid_replan_reason",
  "empty_goal",
  "empty_steps",
  "empty_title",
  "invalid_status",
  "duplicate_step_id",
  "invalid_active_step",
  "multiple_active_steps",
  "blocked_without_note",
  "unsafe_step_identity",
  "suspicious_quality_regression",
])

const isPlanEditState = (value: unknown): value is PlanEditReceipt["state"] =>
  typeof value === "string" && PLAN_EDIT_STATES.has(value as PlanEditReceipt["state"])

const isPlanValidationCode = (value: unknown): value is PlanValidationCode =>
  typeof value === "string" && PLAN_VALIDATION_CODES.has(value as PlanValidationCode)

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string"

const isNullableVersion = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)

const decodeCommand = (value: unknown): PlanEditCommand | null => {
  if (!isRecord(value) || value.protocol_version !== PLAN_EDIT_PROTOCOL_VERSION) return null
  if (!isNonEmptyString(value.activity_id) || !isNonEmptyString(value.request_id)) return null
  if (!isNonEmptyString(value.session_id) || !isNonEmptyString(value.goal_id) || !isTimestamp(value.admitted_at)) return null
  if (typeof value.candidate_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.candidate_hash)) return null
  if (value.confirmed_challenge_id !== undefined && !isNonEmptyString(value.confirmed_challenge_id)) return null
  const planWrite = decodePlanWriteInput(value.plan_write)
  if (!planWrite || planWriteCandidateHash(planWrite) !== value.candidate_hash) return null
  return {
    protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
    activity_id: value.activity_id,
    request_id: value.request_id,
    session_id: value.session_id,
    goal_id: value.goal_id,
    admitted_at: value.admitted_at,
    candidate_hash: value.candidate_hash,
    plan_write: planWrite,
    ...(typeof value.confirmed_challenge_id === "string"
      ? { confirmed_challenge_id: value.confirmed_challenge_id }
      : {}),
  }
}

const decodeChallenge = (value: unknown): PlanEditChallenge | null => {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.challenge_id) || !isNonEmptyString(value.candidate_hash)) return null
  if (!/^sha256:[a-f0-9]{64}$/.test(value.candidate_hash)) return null
  if (!isNonEmptyString(value.expected_plan_id)) return null
  if (typeof value.expected_version !== "number" || !Number.isSafeInteger(value.expected_version) || value.expected_version < 0) {
    return null
  }
  if (!isTimestamp(value.issued_at) || !isTimestamp(value.expires_at)) return null
  if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) return null
  return {
    challenge_id: value.challenge_id,
    candidate_hash: value.candidate_hash,
    expected_plan_id: value.expected_plan_id,
    expected_version: value.expected_version,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
  }
}

const decodeFailure = (value: unknown): PlanEditFailure | null => {
  if (!isRecord(value) || typeof value.kind !== "string") return null
  if (value.kind === "validation") {
    if (!isPlanValidationCode(value.code) || !Array.isArray(value.offending_step_ids)) return null
    if (!value.offending_step_ids.every((item) => typeof item === "string")) return null
    if (!isNullableString(value.previous_plan_id) || !isNullableVersion(value.previous_plan_version)) return null
    return {
      kind: "validation",
      code: value.code,
      offending_step_ids: value.offending_step_ids,
      previous_plan_id: value.previous_plan_id,
      previous_plan_version: value.previous_plan_version,
    }
  }
  if (value.kind === "conflict") {
    if (!isNullableString(value.expected_plan_id) || !isNullableString(value.actual_plan_id)) return null
    if (!isNullableVersion(value.expected_version) || !isNullableVersion(value.actual_version)) return null
    return {
      kind: "conflict",
      expected_plan_id: value.expected_plan_id,
      expected_version: value.expected_version,
      actual_plan_id: value.actual_plan_id,
      actual_version: value.actual_version,
    }
  }
  if (value.kind === "target_unavailable" || value.kind === "runtime_error") {
    if (!isNonEmptyString(value.message)) return null
    return { kind: value.kind, message: value.message }
  }
  return null
}

export const decodePlanEditReceipt = (value: unknown): PlanEditReceipt | null => {
  if (!isRecord(value) || value.protocol_version !== PLAN_EDIT_PROTOCOL_VERSION) return null
  if (!isPlanEditState(value.state)) return null
  const command = decodeCommand(value.command)
  if (!command || !isTimestamp(value.updated_at)) return null
  const challenge = value.challenge === undefined ? undefined : decodeChallenge(value.challenge)
  if (value.state === "challenged" && !challenge) return null
  if (value.state !== "challenged" && value.challenge !== undefined) return null
  const result = isRecord(value.result)
    ? typeof value.result.plan_id === "string" &&
      typeof value.result.doc_id === "string" &&
      typeof value.result.version === "number" &&
      typeof value.result.changed === "boolean"
      ? {
          plan_id: value.result.plan_id,
          doc_id: value.result.doc_id,
          version: value.result.version,
          changed: value.result.changed,
        }
      : null
    : undefined
  const failure = value.failure === undefined ? undefined : decodeFailure(value.failure)
  if (value.state === "applied" && !result) return null
  if (value.state !== "applied" && value.result !== undefined) return null
  if (value.state === "rejected" && !(failure?.kind === "validation" || failure?.kind === "target_unavailable")) return null
  if (value.state === "conflict" && failure?.kind !== "conflict") return null
  if (value.state === "runtime_error" && failure?.kind !== "runtime_error") return null
  if ((value.state === "challenged" || value.state === "queued" || value.state === "applied") && value.failure !== undefined) return null
  return {
    protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
    state: value.state,
    command,
    updated_at: value.updated_at,
    ...(challenge ? { challenge } : {}),
    ...(result ? { result } : {}),
    ...(failure ? { failure } : {}),
  }
}

const mailboxSlug = (goalID: string): string => `goal-plan-edit-mailbox-${goalID}`

const resolveMailbox = (store: DocumentStore, sessionID: string, goalID: string) => {
  const refs = store
    .list({ type: "run_context", scope: planScope(sessionID) })
    .filter((candidate) => store.get(candidate.id)?.extensions?.plan_edit_goal_id === goalID)
  if (refs.length > 1) throw new PlanEditProtocolCorruptionError(refs.map((ref) => ref.id).join(","))
  const doc = refs[0] ? store.get(refs[0].id) : null
  if (!doc) return null
  let value: unknown
  try {
    value = JSON.parse(doc.body)
  } catch {
    throw new PlanEditProtocolCorruptionError(doc.id)
  }
  const receipt = decodePlanEditReceipt(value)
  if (!receipt || receipt.command.session_id !== sessionID || receipt.command.goal_id !== goalID) {
    throw new PlanEditProtocolCorruptionError(doc.id)
  }
  return { doc, receipt }
}

export const readPlanEditReceipt = (store: DocumentStore, sessionID: string, goalID: string): PlanEditReceipt | null =>
  resolveMailbox(store, sessionID, goalID)?.receipt ?? null

export const readPlanEditReceiptByRequest = (
  store: DocumentStore,
  sessionID: string,
  goalID: string,
  requestID: string,
): PlanEditReceipt | null => {
  const mailbox = resolveMailbox(store, sessionID, goalID)
  if (!mailbox) return null
  for (let version = mailbox.doc.version; version > 0; version--) {
    const doc = store.get(mailbox.doc.id, version)
    if (!doc) throw new PlanEditProtocolCorruptionError(`${mailbox.doc.id}@v${version}`)
    let value: unknown
    try {
      value = JSON.parse(doc.body)
    } catch {
      throw new PlanEditProtocolCorruptionError(`${mailbox.doc.id}@v${version}`)
    }
    const receipt = decodePlanEditReceipt(value)
    if (!receipt || receipt.command.session_id !== sessionID || receipt.command.goal_id !== goalID) {
      throw new PlanEditProtocolCorruptionError(`${mailbox.doc.id}@v${version}`)
    }
    if (receipt.command.request_id === requestID) return receipt
  }
  return null
}

export const readPendingPlanEditCommand = (
  store: DocumentStore,
  sessionID: string,
  goalID: string,
): PlanEditCommand | null => {
  const receipt = readPlanEditReceipt(store, sessionID, goalID)
  return receipt?.state === "queued" ? receipt.command : null
}

const writeReceipt = (store: DocumentStore, receipt: PlanEditReceipt): PlanEditReceipt => {
  const current = resolveMailbox(store, receipt.command.session_id, receipt.command.goal_id)
  try {
    store.upsert({
      type: "run_context",
      scope: planScope(receipt.command.session_id),
      description: current?.doc.description ?? `goal plan edit mailbox ${receipt.command.goal_id}`,
      idSlug: mailboxSlug(receipt.command.goal_id),
      body: JSON.stringify(receipt),
      provenance: { source: "human", run_ref: planScope(receipt.command.session_id) },
      extensions: {
        plan_edit_goal_id: receipt.command.goal_id,
        plan_edit_protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
      },
    })
    return receipt
  } catch (error) {
    if (!(error instanceof DocumentConflictError)) throw error
    store.rebuildIndex()
    throw new PlanEditMailboxConflictError()
  }
}

export const createPlanEditCommand = (input: {
  readonly requestID: string
  readonly sessionID: string
  readonly goalID: string
  readonly planWrite: PlanWriteInput
  readonly now?: Date
  readonly confirmedChallengeID?: string
}): PlanEditCommand => ({
  protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
  activity_id: randomUUID(),
  request_id: input.requestID,
  session_id: input.sessionID,
  goal_id: input.goalID,
  admitted_at: (input.now ?? new Date()).toISOString(),
  candidate_hash: planWriteCandidateHash(input.planWrite),
  plan_write: input.planWrite,
  ...(input.confirmedChallengeID ? { confirmed_challenge_id: input.confirmedChallengeID } : {}),
})

const reconcileRequestRetry = (store: DocumentStore, command: PlanEditCommand): PlanEditReceipt | null => {
  const receipt = readPlanEditReceiptByRequest(store, command.session_id, command.goal_id, command.request_id)
  if (!receipt) return null
  if (receipt.command.candidate_hash === command.candidate_hash) return receipt
  throw new PlanEditRequestConflictError(command.request_id)
}

export const admitPlanEditCommand = (
  store: DocumentStore,
  command: PlanEditCommand,
  now = new Date(),
): PlanEditReceipt => {
  const retry = reconcileRequestRetry(store, command)
  if (retry) return retry
  const current = readPlanEditReceipt(store, command.session_id, command.goal_id)
  if (current?.state === "queued") throw new PlanEditBusyError(current.command.activity_id)
  if (command.confirmed_challenge_id) {
    if (!current || current.state !== "challenged" || !current.challenge) throw new PlanEditChallengeError("missing")
    if (current.challenge.challenge_id !== command.confirmed_challenge_id) throw new PlanEditChallengeError("mismatch")
    if (
      current.challenge.candidate_hash !== command.candidate_hash ||
      current.challenge.expected_plan_id !== command.plan_write.expected_plan_id ||
      current.challenge.expected_version !== command.plan_write.expected_version
    ) {
      throw new PlanEditChallengeError("mismatch")
    }
    if (Date.parse(current.challenge.expires_at) <= now.getTime()) throw new PlanEditChallengeError("expired")
  }
  return writeReceipt(store, {
    protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
    state: "queued",
    command,
    updated_at: now.toISOString(),
  })
}

export const issuePlanEditChallenge = (
  store: DocumentStore,
  command: PlanEditCommand,
  challengeID: string,
  now = new Date(),
): PlanEditReceipt => {
  const retry = reconcileRequestRetry(store, command)
  if (retry) return retry
  const current = readPlanEditReceipt(store, command.session_id, command.goal_id)
  if (current?.state === "queued") throw new PlanEditBusyError(current.command.activity_id)
  if (command.plan_write.expected_plan_id == null || command.plan_write.expected_version == null) {
    throw new PlanEditChallengeError("mismatch")
  }
  return writeReceipt(store, {
    protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
    state: "challenged",
    command,
    updated_at: now.toISOString(),
    challenge: {
      challenge_id: challengeID,
      candidate_hash: command.candidate_hash,
      expected_plan_id: command.plan_write.expected_plan_id,
      expected_version: command.plan_write.expected_version,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PLAN_EDIT_CHALLENGE_TTL_MS).toISOString(),
    },
  })
}

export const settlePlanEditCommand = (
  store: DocumentStore,
  command: PlanEditCommand,
  settlement: PlanEditSettlement,
  now = new Date(),
): PlanEditReceipt => {
  const current = readPlanEditReceipt(store, command.session_id, command.goal_id)
  if (current && current.command.activity_id === command.activity_id && current.state !== "queued") return current
  if (!current || current.state !== "queued" || current.command.activity_id !== command.activity_id) {
    throw new PlanEditMailboxConflictError()
  }
  if (settlement.state === "rejected" && !(settlement.failure.kind === "validation" || settlement.failure.kind === "target_unavailable")) {
    throw new PlanEditProtocolCorruptionError(current.command.activity_id)
  }
  if (settlement.state === "conflict" && settlement.failure.kind !== "conflict") {
    throw new PlanEditProtocolCorruptionError(current.command.activity_id)
  }
  if (settlement.state === "runtime_error" && settlement.failure.kind !== "runtime_error") {
    throw new PlanEditProtocolCorruptionError(current.command.activity_id)
  }
  return writeReceipt(store, {
    protocol_version: PLAN_EDIT_PROTOCOL_VERSION,
    state: settlement.state,
    command,
    updated_at: now.toISOString(),
    ...(settlement.state === "applied" ? { result: settlement.result } : { failure: settlement.failure }),
  })
}

export const planEditFailure = (error: unknown): PlanEditFailure => {
  const validation = error as Partial<PlanValidationError>
  if (validation._tag === "PlanValidationError" && validation.code) {
    return {
      kind: "validation",
      code: validation.code,
      offending_step_ids: validation.offending_step_ids ?? [],
      previous_plan_id: validation.previous_plan_id ?? null,
      previous_plan_version: validation.previous_plan_version ?? null,
    }
  }
  const conflict = error as Partial<PlanConflictError>
  if (conflict._tag === "PlanConflictError") {
    return {
      kind: "conflict",
      expected_plan_id: conflict.expected?.plan_id ?? null,
      expected_version: conflict.expected?.version ?? null,
      actual_plan_id: conflict.actual?.plan_id ?? null,
      actual_version: conflict.actual?.version ?? null,
    }
  }
  if (error instanceof PlanEditTargetUnavailableError) {
    return { kind: "target_unavailable", message: error.message }
  }
  return {
    kind: "runtime_error",
    message: error instanceof Error ? error.message : "Unknown plan edit runtime failure",
  }
}
