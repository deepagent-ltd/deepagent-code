export * as SessionTransfer from "./transfer"

import { randomUUID } from "crypto"
import { and, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventSequenceTable } from "../event/sql"
import { WorkspaceV2 } from "../workspace"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionTransferOperationTable, SessionTransferTargetReceiptTable } from "./transfer.sql"

// §16.3 order 5 F4 — durable transfer admission orchestration. The DB authority lives in
// migration 20260813133000 (state machine + identity immutability + source input fence + target
// receipt guards); this module is the ONLY TS orchestrator allowed to drive those rows. Every
// expected rejection is surfaced as a typed error BEFORE the DB call; DB trigger aborts are a
// last-resort defect (fail-closed, never legacy fallback) because the pre-validation and the
// same-transaction ordering make them unreachable in sequential execution. The write fence is
// ONE-WAY once set (the fence trigger refuses clearing it): aborting a frozen source leaves the
// session fenced — recovery goes through a NEW transfer, never a silent unfence.
// Owner settlement (source_owner_id/target_owner_id) is recorded evidence here; applying owner
// placement to the execution layer is owned by the ownership/execution authority, out of scope
// for this package.

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionTransfer.SessionNotFoundError",
  { sessionID: Schema.String },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionTransfer.NotFoundError", {
  transferID: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionTransfer.ConflictError", {
  sessionID: Schema.String,
  reason: Schema.Union([
    Schema.Literal("active_transfer"),
    Schema.Literal("event_authority_missing"),
    Schema.Literal("receipt_identity_mismatch"),
  ]),
  message: Schema.String,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("SessionTransfer.InvalidStateError", {
  transferID: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("SessionTransfer.ValidationError", {
  transferID: Schema.String,
  field: Schema.String,
  message: Schema.String,
}) {}

export type State = "admitted" | "source_frozen" | "target_staged" | "owner_committed" | "target_activated" | "aborted"

export type Operation = typeof SessionTransferOperationTable.$inferSelect

export type AdmissionRequest = {
  readonly sessionID: SessionSchema.ID
  readonly sourceWorkspaceID?: string
  readonly targetWorkspaceID?: string
  readonly sourceOwnerID?: string
  readonly targetOwnerID?: string
}

// Exact-retry identity = exactly what the caller stated. Captured evidence (event seq, mutation
// epoch) is recorded on the row but is NOT part of the identity, so a crash-retry of the same
// request converges instead of diverging.
export const requestHash = (input: AdmissionRequest) =>
  Hash.sha256(
    CanonicalJson.stringify({
      sessionID: input.sessionID,
      sourceWorkspaceID: input.sourceWorkspaceID ?? null,
      targetWorkspaceID: input.targetWorkspaceID ?? null,
      sourceOwnerID: input.sourceOwnerID ?? null,
      targetOwnerID: input.targetOwnerID ?? null,
    }),
  )

export const ID = {
  create: () => `str_${randomUUID()}`,
}

const ACTIVE_STATES = ["admitted", "source_frozen", "target_staged", "owner_committed"] as const

export const get = (db: Database.Interface["db"], transferID: string) =>
  db
    .select()
    .from(SessionTransferOperationTable)
    .where(eq(SessionTransferOperationTable.transfer_id, transferID))
    .get()
    .pipe(Effect.orDie)

// Contract for freezeSource/stageTarget/activate: the caller must not admit further durable
// events between admit and freezeSource. source_event_seq is the admit-time frontier, and the
// freeze fence keeps it stable from the freeze onward.
const validSnapshot = (input: { readonly transferID: string; readonly snapshotID: string; readonly snapshotHash: string }) => {
  if (input.snapshotID.trim().length === 0)
    return new ValidationError({ transferID: input.transferID, field: "snapshotID", message: "snapshot ID must not be empty" })
  if (!/^[0-9a-f]{64}$/.test(input.snapshotHash))
    return new ValidationError({
      transferID: input.transferID,
      field: "snapshotHash",
      message: "snapshot hash must be a 64-char lowercase hex digest",
    })
  return undefined
}

// Admit exactly one durable transfer operation per session. Same-request retries converge on the
// existing row; a DIFFERENT request while an operation is still active fails closed (the unique
// partial index on non-terminal states is the DB-side twin of this check). Concurrent same-request
// admits race to the UNIQUE(session_id, request_hash) constraint: the loser re-reads and converges
// instead of surfacing the constraint as a defect.
export const admit = Effect.fn("SessionTransfer.admit")(function* (
  db: Database.Interface["db"],
  input: AdmissionRequest & { readonly transferID?: string; readonly now?: number },
) {
  const session = yield* db
    .select({ workspaceID: SessionTable.workspace_id, mutationEpoch: SessionTable.mutation_epoch })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* new SessionNotFoundError({ sessionID: input.sessionID })

  const hash = requestHash(input)
  const existing = yield* db
    .select()
    .from(SessionTransferOperationTable)
    .where(and(eq(SessionTransferOperationTable.session_id, input.sessionID), eq(SessionTransferOperationTable.request_hash, hash)))
    .get()
    .pipe(Effect.orDie)
  if (existing) return existing

  const active = yield* db
    .select({ transferId: SessionTransferOperationTable.transfer_id })
    .from(SessionTransferOperationTable)
    .where(and(eq(SessionTransferOperationTable.session_id, input.sessionID), inArray(SessionTransferOperationTable.state, [...ACTIVE_STATES])))
    .get()
    .pipe(Effect.orDie)
  if (active)
    return yield* new ConflictError({
      sessionID: input.sessionID,
      reason: "active_transfer",
      message: `Transfer ${active.transferId} is already active for this session`,
    })

  // The source event authority must exist before admission: source_event_seq is captured
  // evidence of the frozen frontier, and a session without an event sequence row has no durable
  // frontier to fence.
  const sequence = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!sequence)
    return yield* new ConflictError({
      sessionID: input.sessionID,
      reason: "event_authority_missing",
      message: "Session has no event sequence authority to fence",
    })

  const now = input.now ?? Date.now()
  const row: typeof SessionTransferOperationTable.$inferInsert = {
    transfer_id: input.transferID ?? ID.create(),
    session_id: input.sessionID,
    source_workspace_id: input.sourceWorkspaceID,
    target_workspace_id: input.targetWorkspaceID,
    source_owner_id: input.sourceOwnerID,
    target_owner_id: input.targetOwnerID,
    source_event_seq: sequence.seq,
    source_mutation_epoch: session.mutationEpoch,
    state: "admitted",
    request_hash: hash,
    created_at: now,
    updated_at: now,
  }
  const findByRequest = () =>
    db
      .select()
      .from(SessionTransferOperationTable)
      .where(and(eq(SessionTransferOperationTable.session_id, input.sessionID), eq(SessionTransferOperationTable.request_hash, hash)))
      .get()
      .pipe(Effect.orDie)
  yield* db.insert(SessionTransferOperationTable).values(row).pipe(
    // Lost a concurrent same-request insert race: converge on the winner (which carries a
    // different transfer_id) instead of surfacing the UNIQUE(session_id, request_hash)
    // constraint as a defect. Re-reading by request identity keeps the return shape identical
    // across first-admit and retry paths.
    Effect.catch(() => findByRequest()),
  )
  return (yield* findByRequest()) ?? row
})

// Freeze the source: set the one-way event write fence and record the source snapshot. The fence
// trigger only accepts a fence for an operation in admitted/source_frozen state, and the session
// input trigger rejects new durable inputs once fenced — admission-before-wake keeps the source
// quiet from that point on.
export const freezeSource = Effect.fn("SessionTransfer.freezeSource")(function* (
  db: Database.Interface["db"],
  input: { readonly transferID: string; readonly snapshotID: string; readonly snapshotHash: string; readonly now?: number },
) {
  const invalid = validSnapshot(input)
  if (invalid) return yield* invalid
  return yield* db.transaction(() =>
    Effect.gen(function* () {
      const operation = yield* get(db, input.transferID)
      if (!operation) return yield* new NotFoundError({ transferID: input.transferID })
      if (operation.state === "source_frozen") {
        // Same-snapshot retries converge; a different snapshot against a frozen source is a
        // divergent retry and fails closed.
        if (operation.snapshot_id === input.snapshotID && operation.snapshot_hash === input.snapshotHash) return operation
        return yield* new InvalidStateError({ transferID: input.transferID, expected: "admitted", actual: operation.state })
      }
      if (operation.state !== "admitted")
        return yield* new InvalidStateError({ transferID: input.transferID, expected: "admitted", actual: operation.state })
      yield* db
        .update(EventSequenceTable)
        .set({ write_fence_transfer_id: input.transferID })
        .where(eq(EventSequenceTable.aggregate_id, operation.session_id))
        .pipe(Effect.orDie)
      const updated = {
        state: "source_frozen" as const,
        snapshot_id: input.snapshotID,
        snapshot_hash: input.snapshotHash,
        updated_at: input.now ?? Date.now(),
      }
      yield* db
        .update(SessionTransferOperationTable)
        .set(updated)
        .where(eq(SessionTransferOperationTable.transfer_id, input.transferID))
        .pipe(Effect.orDie)
      return { ...operation, ...updated }
    }),
  )
})

// Stage the target receipt. The receipt identity is the source snapshot evidence; it is created
// exactly once per transfer and converges on identical re-staging.
export const stageTarget = Effect.fn("SessionTransfer.stageTarget")(function* (
  db: Database.Interface["db"],
  input: { readonly transferID: string; readonly now?: number },
) {
  return yield* db.transaction(() =>
    Effect.gen(function* () {
      const operation = yield* get(db, input.transferID)
      if (!operation) return yield* new NotFoundError({ transferID: input.transferID })
      if (operation.state === "target_staged") return operation
      if (operation.state !== "source_frozen")
        return yield* new InvalidStateError({ transferID: input.transferID, expected: "source_frozen", actual: operation.state })
      if (!operation.snapshot_id || !operation.snapshot_hash)
        return yield* new ValidationError({
          transferID: input.transferID,
          field: "snapshot",
          message: "frozen source is missing snapshot evidence",
        })
      const existingReceipt = yield* db
        .select()
        .from(SessionTransferTargetReceiptTable)
        .where(eq(SessionTransferTargetReceiptTable.transfer_id, input.transferID))
        .get()
        .pipe(Effect.orDie)
      if (existingReceipt) {
        const matches =
          existingReceipt.session_id === operation.session_id &&
          existingReceipt.source_snapshot_id === operation.snapshot_id &&
          existingReceipt.source_snapshot_hash === operation.snapshot_hash &&
          existingReceipt.source_event_seq === operation.source_event_seq
        if (!matches)
          return yield* new ConflictError({
            sessionID: operation.session_id,
            reason: "receipt_identity_mismatch",
            message: `Target receipt for ${input.transferID} disagrees with the frozen source evidence`,
          })
      } else {
        const now = input.now ?? Date.now()
        yield* db
          .insert(SessionTransferTargetReceiptTable)
          .values({
            transfer_id: input.transferID,
            session_id: operation.session_id,
            source_snapshot_id: operation.snapshot_id,
            source_snapshot_hash: operation.snapshot_hash,
            source_event_seq: operation.source_event_seq,
            target_workspace_id: operation.target_workspace_id,
            target_owner_id: operation.target_owner_id,
            state: "staged",
            created_at: now,
          })
          .pipe(Effect.orDie)
      }
      const updated = { state: "target_staged" as const, updated_at: input.now ?? Date.now() }
      yield* db
        .update(SessionTransferOperationTable)
        .set(updated)
        .where(eq(SessionTransferOperationTable.transfer_id, input.transferID))
        .pipe(Effect.orDie)
      return { ...operation, ...updated }
    }),
  )
})

export const commitOwner = Effect.fn("SessionTransfer.commitOwner")(function* (
  db: Database.Interface["db"],
  input: { readonly transferID: string; readonly now?: number },
) {
  const operation = yield* get(db, input.transferID)
  if (!operation) return yield* new NotFoundError({ transferID: input.transferID })
  if (operation.state === "owner_committed") return operation
  if (operation.state !== "target_staged")
    return yield* new InvalidStateError({ transferID: input.transferID, expected: "target_staged", actual: operation.state })
  const updated = { state: "owner_committed" as const, updated_at: input.now ?? Date.now() }
  yield* db
    .update(SessionTransferOperationTable)
    .set(updated)
    .where(eq(SessionTransferOperationTable.transfer_id, input.transferID))
    .pipe(Effect.orDie)
  return { ...operation, ...updated }
})

// Activate: flip the receipt, settle the operation, and move the session placement. All three
// writes share one transaction — a crash before it simply replays from owner_committed. A transfer
// without a target workspace leaves the current placement untouched (placement move is optional).
export const activate = Effect.fn("SessionTransfer.activate")(function* (
  db: Database.Interface["db"],
  input: { readonly transferID: string; readonly activatedSnapshotID: string; readonly now?: number },
) {
  return yield* db.transaction(() =>
    Effect.gen(function* () {
      const operation = yield* get(db, input.transferID)
      if (!operation) return yield* new NotFoundError({ transferID: input.transferID })
      if (operation.state === "target_activated") return operation
      if (operation.state !== "owner_committed")
        return yield* new InvalidStateError({ transferID: input.transferID, expected: "owner_committed", actual: operation.state })
      const now = input.now ?? Date.now()
      yield* db
        .update(SessionTransferTargetReceiptTable)
        .set({ state: "activated", activated_snapshot_id: input.activatedSnapshotID, activated_at: now })
        .where(eq(SessionTransferTargetReceiptTable.transfer_id, input.transferID))
        .pipe(Effect.orDie)
      const updated = { state: "target_activated" as const, updated_at: now, completed_at: now }
      yield* db
        .update(SessionTransferOperationTable)
        .set(updated)
        .where(eq(SessionTransferOperationTable.transfer_id, input.transferID))
        .pipe(Effect.orDie)
      if (operation.target_workspace_id != null)
        yield* db
          .update(SessionTable)
          .set({ workspace_id: operation.target_workspace_id as WorkspaceV2.ID })
          .where(eq(SessionTable.id, operation.session_id as SessionSchema.ID))
          .pipe(Effect.orDie)
      return { ...operation, ...updated }
    }),
  )
})

// Abort is reachable from admitted and source_frozen. The one-way fence survives a frozen-source
// abort: the session stays fenced and recovery proceeds through a NEW transfer, never an unfence.
export const abort = Effect.fn("SessionTransfer.abort")(function* (
  db: Database.Interface["db"],
  input: { readonly transferID: string; readonly errorCode?: string; readonly now?: number },
) {
  const operation = yield* get(db, input.transferID)
  if (!operation) return yield* new NotFoundError({ transferID: input.transferID })
  if (operation.state === "aborted") return operation
  if (operation.state !== "admitted" && operation.state !== "source_frozen")
    return yield* new InvalidStateError({ transferID: input.transferID, expected: "admitted/source_frozen", actual: operation.state })
  const updated = { state: "aborted" as const, error_code: input.errorCode, updated_at: input.now ?? Date.now() }
  yield* db
    .update(SessionTransferOperationTable)
    .set(updated)
    .where(eq(SessionTransferOperationTable.transfer_id, input.transferID))
    .pipe(Effect.orDie)
  return { ...operation, ...updated }
})
