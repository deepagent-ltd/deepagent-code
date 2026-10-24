export * as GoalPauseBoundary from "./goal-pause-boundary"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionInputTable, SessionTable } from "../session/sql"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { GoalChild } from "./goal-child"
import { GoalChildResult } from "./goal-child-result"
import type { GoalChildExecution } from "./goal-child-execution"
import { GoalChildUnitTable } from "./goal-child.sql"
import { GoalControl } from "./goal-control"
import { GoalControlSchema } from "./goal-control.schema"
import { GoalControlCommandTable, GoalControlTable, GoalTickPermitTable } from "./goal-control.sql"
import { GoalPauseBoundaryTable } from "./goal-pause-boundary.sql"
import { GoalPlanRebase } from "./goal-plan-rebase"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"
import { GoalTickCheckpointTable } from "./goal-tick-checkpoint.sql"
import { GoalTickProgram } from "./goal-tick-program"
import { GoalTickState } from "./goal-tick-state"
import { DocumentStore } from "./document-store"

type Db = Database.Interface["db"]
type Reader = GoalTickCheckpoint.Reader
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const RecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  permitID: GoalTickProgram.Ref,
  goalID: GoalTickProgram.Ref,
  sessionID: GoalTickProgram.Ref,
  commandID: GoalTickProgram.Ref,
  controlRevision: Count,
  tickSeq: Count,
  planRevision: Count,
  planRebaseID: Schema.NullOr(GoalTickProgram.Ref),
  initializationHash: GoalTickProgram.Hash,
  permitHash: GoalTickProgram.Hash,
  checkpointRevision: Count,
  checkpointHash: GoalTickProgram.Hash,
  factsHash: GoalTickProgram.Hash,
  sourceReceiptHash: GoalTickProgram.Hash,
  sourceDocumentsHash: GoalTickProgram.Hash,
  transitionHash: GoalTickProgram.Hash,
  // Complete immutable bytes, including unchanged plan/diagnosis/completion documents.
  documents: Schema.Array(GoalTickProgram.FullDocument).check(Schema.isMaxLength(8)),
})
export type Record = typeof RecordSchema.Type
export type Row = typeof GoalPauseBoundaryTable.$inferSelect
export type Quiescence = {
  readonly permit: GoalControl.Permit
  readonly commandID: string
  readonly controlRevision: number
  readonly targets: readonly GoalChildExecution.Target[]
}
const fail = (message: string) => new GoalControlSchema.Error({ code: "recovery_required", message })
const permitHash = (permit: GoalControl.Permit) =>
  GoalControl.fingerprint({
    id: permit.permit_id,
    token: permit.token,
    goal: permit.goal_id,
    tick: permit.tick_seq,
    revision: permit.control_revision,
    plan: permit.plan_version,
    owner: permit.owner_id,
  })

/** Reading these rows never manufactures the live original registry witness. */
export const read = (db: Reader, permitID: string) =>
  Effect.gen(function* () {
    const size = yield* db.get<{ bytes: number }>(
      sql`SELECT length(CAST(record AS BLOB)) AS bytes FROM goal_pause_boundary WHERE permit_id=${permitID}`,
    )
    if (!size) return undefined
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 2 || size.bytes > GoalTickProgram.MAX_BYTES)
      return yield* fail("Goal pause receipt exceeds its bounded storage")
    const row = yield* db
      .select()
      .from(GoalPauseBoundaryTable)
      .where(eq(GoalPauseBoundaryTable.permit_id, permitID))
      .get()
    if (!row) return yield* fail("Goal pause receipt disappeared")
    const decoded = Schema.decodeUnknownOption(RecordSchema, { onExcessProperty: "error" })(row.record)
    if (
      Option.isNone(decoded) ||
      row.logical_bytes !== size.bytes ||
      row.reserved_bytes !== GoalTickProgram.MAX_BYTES ||
      row.record_hash !== GoalControl.fingerprint(row.record) ||
      row.permit_id !== decoded.value.permitID ||
      row.goal_id !== decoded.value.goalID ||
      row.command_id !== decoded.value.commandID ||
      !["prepared", "committed"].includes(row.state)
    )
      return yield* fail("Goal pause receipt binding changed")
    if (
      decoded.value.documents.length < 2 ||
      new Set(decoded.value.documents.map((item) => item.documentID)).size !== decoded.value.documents.length
    )
      return yield* fail("Goal pause receipt has an incomplete document set")
    for (const document of decoded.value.documents) {
      const payload = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(
        document.payload,
      )
      if (
        Option.isNone(payload) ||
        payload.value.id !== document.documentID ||
        document.payloadHash !== GoalTickProgram.hash(document.payload) ||
        (document.expectedVersion === null) !== (document.expectedHash === null) ||
        (document.state === "confirmed" &&
          (document.observedVersion !== payload.value.version ||
            document.observedHash !== GoalTickProgram.hash(payload.value)))
      )
        return yield* fail("Goal pause projection bytes changed")
    }
    return row
  })

/** An explicit replay may acknowledge bytes already projected before a crash. This is not a
 * replacement for the original live registry: it never writes documents or settles a permit. */
export const reconcileProjection = (
  db: Db,
  input: { goalID: string; sessionID: string; commandID: string; directory: string },
) =>
  Effect.gen(function* () {
    const candidates = yield* db
      .select({ permitID: GoalPauseBoundaryTable.permit_id })
      .from(GoalPauseBoundaryTable)
      .where(
        and(eq(GoalPauseBoundaryTable.goal_id, input.goalID), eq(GoalPauseBoundaryTable.command_id, input.commandID)),
      )
      .limit(2)
      .all()
    if (!candidates.length) return
    if (candidates.length !== 1) return yield* fail("Original pause projection is ambiguous")
    const original = yield* read(db, candidates[0]!.permitID)
    if (!original || original.state === "committed") return
    for (const mirror of original.record.documents) {
      const row = yield* projectionSource(db, original.permit_id, input)
      const observed = yield* Effect.try({
        try: () => {
          const store = DocumentStore.openExact(
            input.directory,
            row.record.documents.map((item) => item.documentID),
          )
          const document = store.get(mirror.documentID)
          const payload = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(
            mirror.payload,
          )
          if (
            document &&
            GoalTickProgram.canonical(document) ===
              GoalTickProgram.canonical({
                ...payload,
                hash: `sha256:${GoalTickProgram.hash(payload)}`,
              })
          )
            return { version: document.version, hash: document.hash.slice(7) }
          // An unstarted projection remains pending. Neither absence nor an old version grants a write.
          if (
            mirror.state === "pending" &&
            document?.version === mirror.expectedVersion &&
            document.hash === `sha256:${mirror.expectedHash}`
          )
            return undefined
          throw fail("Original pause document differs from its frozen bytes")
        },
        catch: () => fail("Original pause document cannot be inspected"),
      })
      if (!observed || mirror.state === "confirmed") continue
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* projectionSource(tx, row.permit_id, input)
            if (current.record_hash !== row.record_hash)
              return yield* fail("Original pause projection changed during inspection")
            yield* update(tx, current, {
              ...current.record,
              documents: current.record.documents.map((item) =>
                item.documentID === mirror.documentID
                  ? { ...item, state: "confirmed", observedVersion: observed.version, observedHash: observed.hash }
                  : item,
              ),
            })
          }),
        { behavior: "immediate" },
      )
    }
  }).pipe(
    GoalChildResult.withRuntimeIdentity(db),
    Effect.catch((error) =>
      error instanceof GoalControlSchema.Error
        ? Effect.fail(error)
        : fail("Original pause projection could not be reconciled"),
    ),
    Effect.catchDefect(() => fail("Original pause projection could not be safely decoded")),
  )

function projectionSource(
  db: Reader,
  permitID: string,
  input: { goalID: string; sessionID: string; commandID: string },
) {
  return Effect.gen(function* () {
    const row = yield* read(db, permitID)
    const goal = yield* GoalControl.requireTarget(db, input.goalID, input.sessionID)
    const permit = yield* db.select().from(GoalTickPermitTable).where(eq(GoalTickPermitTable.permit_id, permitID)).get()
    const command = yield* db
      .select()
      .from(GoalControlCommandTable)
      .where(eq(GoalControlCommandTable.command_id, input.commandID))
      .get()
    const checkpoint = yield* GoalTickCheckpointV2.read(db, permitID)
    if (
      !row ||
      row.state !== "prepared" ||
      row.goal_id !== input.goalID ||
      row.command_id !== input.commandID ||
      row.record.sessionID !== input.sessionID ||
      !permit ||
      row.record.permitHash !== permitHash(permit) ||
      !["issued", "unknown"].includes(permit.state) ||
      !checkpoint ||
      !["prepared", "running", "recovery_required"].includes(checkpoint.state) ||
      row.record.checkpointRevision !== checkpoint.revision ||
      row.record.checkpointHash !== checkpoint.journal_hash ||
      goal.requested_phase !== "paused" ||
      goal.revision !== row.record.controlRevision ||
      goal.revision !== permit.control_revision + 1 ||
      goal.next_seq !== row.record.tickSeq ||
      goal.next_seq !== permit.tick_seq ||
      goal.plan_version !== permit.plan_version ||
      goal.plan_revision !== row.record.planRevision ||
      goal.plan_rebase_id !== row.record.planRebaseID ||
      goal.initialization_hash !== row.record.initializationHash ||
      goal.pending_rebase_id ||
      goal.recovery_reason ||
      goal.initialization.executionContract !== "owned-goal-v2" ||
      command?.action !== "pause" ||
      command.goal_id !== input.goalID ||
      command.session_id !== input.sessionID ||
      command.revision !== goal.revision
    )
      return yield* fail("Original pause projection source is no longer current")
    yield* GoalTickCheckpoint.requireParentSourceFacts(db, checkpoint)
    const base = yield* GoalPlanRebase.baseline(db, goal)
    if (
      base.receiptHash !== row.record.sourceReceiptHash ||
      GoalTickProgram.hash(base.documents) !== row.record.sourceDocumentsHash ||
      (yield* neverDispatched(db, checkpoint)).hash !== row.record.factsHash
    )
      return yield* fail("Original pause projection source facts changed")
    return row
  })
}

/** Only the original trusted Host registry supplies inspect. There is no exported token constructor,
 * Context override, JSON proof, or row-to-witness conversion. Each SQL/file boundary rechecks it. */
export function authority<Witness>(inspect: (witness: Witness) => Quiescence | undefined) {
  return (db: Db, input: { witness: Witness; directory: string }) =>
    Effect.gen(function* () {
      const current = () => {
        const proof = inspect(input.witness)
        return proof && proof.permit.owner_id === GoalControl.ownerID
          ? Effect.succeed(proof)
          : Effect.fail(fail("Original paused Goal frame is not quiescent"))
      }
      const captured = yield* current()
      const prepared = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const proof = yield* current()
            const source = yield* requirePause(tx, proof)
            const prior = yield* read(tx, proof.permit.permit_id)
            if (prior) {
              if (prior.command_id !== proof.commandID) return yield* fail("A different pause owns this boundary")
              return prior
            }
            const facts = yield* neverDispatched(tx, source.checkpoint, proof)
            const base = yield* GoalPlanRebase.baseline(tx, source.goal)
            const ids = source.checkpoint.journal.program.documents.map((item) => item.id)
            if (
              base.documents.length !== ids.length ||
              ids.some((id) => !base.documents.some((item) => item.id === id))
            )
              return yield* fail("Paused Goal has no complete original document baseline")
            const stateDoc = base.documents.find((item) => item.id === `doc:run_context:${source.goal.goal_id}`)
            const state =
              stateDoc && Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickState.Runtime))(stateDoc.body)
            if (
              !stateDoc ||
              !state ||
              Option.isNone(state) ||
              state.value.ledger.ticks !== proof.permit.tick_seq ||
              state.value.goalId !== source.goal.goal_id ||
              state.value.sessionId !== source.goal.session_id ||
              state.value.phase !== "running" ||
              GoalControl.fingerprint(state.value.spec) !== GoalControl.fingerprint(source.goal.initialization.spec)
            )
              return yield* fail("Paused Goal runtime differs from its original tick frontier")
            const transitionHash = GoalTickProgram.hash({
              permit: permitHash(proof.permit),
              command: proof.commandID,
              checkpoint: source.checkpoint.journal_hash,
              facts: facts.hash,
              source: base.receiptHash,
            })
            const next = yield* Effect.try({
              try: () =>
                GoalTickState.requireState({
                  ...state.value,
                  ledger: {
                    ...state.value.ledger,
                    ticks: state.value.ledger.ticks + 1,
                    wallclockMs: Math.max(state.value.ledger.wallclockMs, Date.now() - state.value.ledger.startedAtMs),
                  },
                  lastTransitionHash: transitionHash,
                }),
              catch: () => fail("Paused Goal successor exceeds its complete state boundary"),
            })
            const documents = base.documents.map((document) => {
              const changed = document.id === stateDoc.id || document.id === `doc:worklog:${source.goal.goal_id}`
              const payload = GoalTickProgram.canonical(
                changed
                  ? {
                      ...document,
                      version: document.version + 1,
                      body:
                        document.id === stateDoc.id
                          ? GoalTickProgram.canonical(next)
                          : GoalTickProgram.canonical({
                              version: 1,
                              prior: {
                                documentID: document.id,
                                version: document.version,
                                hash: GoalTickProgram.hash(document),
                              },
                              outcome: "halted-before-dispatch",
                              permitID: proof.permit.permit_id,
                              commandID: proof.commandID,
                              transitionHash,
                              stageCount: facts.stageCount,
                              usage: { input: 0, output: 0, cost: 0, complete: true },
                            }),
                    }
                  : document,
              )
              return {
                documentID: document.id,
                expectedVersion: document.version,
                expectedHash: GoalTickProgram.hash(document),
                payload,
                payloadHash: GoalTickProgram.hash(payload),
                state: "pending" as const,
                observedVersion: null,
                observedHash: null,
              }
            })
            const record: Record = {
              version: 1,
              permitID: proof.permit.permit_id,
              goalID: source.goal.goal_id,
              sessionID: source.goal.session_id,
              commandID: proof.commandID,
              controlRevision: proof.controlRevision,
              tickSeq: proof.permit.tick_seq,
              planRevision: source.goal.plan_revision,
              planRebaseID: source.goal.plan_rebase_id,
              initializationHash: source.goal.initialization_hash,
              permitHash: permitHash(proof.permit),
              checkpointRevision: source.checkpoint.revision,
              checkpointHash: source.checkpoint.journal_hash,
              factsHash: facts.hash,
              sourceReceiptHash: base.receiptHash,
              sourceDocumentsHash: GoalTickProgram.hash(base.documents),
              transitionHash,
              documents,
            }
            if (
              !Schema.is(RecordSchema)(record) ||
              Buffer.byteLength(JSON.stringify(record)) > GoalTickProgram.MAX_BYTES
            )
              return yield* fail("Goal pause receipt cannot reserve its full encoded result")
            const capacity = yield* tx.get<{ records: number; bytes: number }>(
              sql`SELECT count(*) AS records,coalesce(sum(reserved_bytes),0) AS bytes FROM (SELECT reserved_bytes FROM goal_tick_checkpoint UNION ALL SELECT reserved_bytes FROM goal_pause_boundary)`,
            )
            if (!capacity || capacity.records >= 100000 || capacity.bytes + GoalTickProgram.MAX_BYTES > 268435456)
              return yield* fail("Goal pause receipt capacity is exhausted; execution remains revoked")
            const now = Date.now()
            const row = yield* tx
              .insert(GoalPauseBoundaryTable)
              .values({
                permit_id: record.permitID,
                goal_id: record.goalID,
                command_id: record.commandID,
                state: "prepared",
                record,
                record_hash: GoalControl.fingerprint(record),
                logical_bytes: Buffer.byteLength(JSON.stringify(record)),
                reserved_bytes: GoalTickProgram.MAX_BYTES,
                created_at: now,
                updated_at: now,
              })
              .returning()
              .get()
            if (!row) return yield* fail("Goal pause boundary was not reserved")
            return row
          }),
        { behavior: "immediate" },
      )
      if (prepared.state === "committed") return prepared
      for (const document of prepared.record.documents)
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const proof = yield* current()
              const source = yield* requirePause(tx, proof)
              const row = yield* read(tx, proof.permit.permit_id)
              if (!row || row.state !== "prepared")
                return yield* fail("Original pause projection is no longer prepared")
              yield* recheck(tx, row, source, proof)
              const mirror = row.record.documents.find((item) => item.documentID === document.documentID)!
              const observed = yield* project(input.directory, row.record, mirror)
              if (mirror.state === "confirmed") return
              const record: Record = {
                ...row.record,
                documents: row.record.documents.map((item) =>
                  item.documentID === mirror.documentID
                    ? { ...item, state: "confirmed", observedVersion: observed.version, observedHash: observed.hash }
                    : item,
                ),
              }
              yield* update(tx, row, record)
            }),
          { behavior: "immediate" },
        )
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const proof = yield* current()
            if (permitHash(captured.permit) !== permitHash(proof.permit))
              return yield* fail("Pause registry scope changed")
            const source = yield* requirePause(tx, proof)
            const row = yield* read(tx, proof.permit.permit_id)
            if (!row || row.state !== "prepared" || row.record.documents.some((item) => item.state !== "confirmed"))
              return yield* fail("Pause documents are not completely confirmed")
            yield* recheck(tx, row, source, proof)
            // Re-read files after all CAS writes; an ACK by itself is not immutable file authority.
            for (const mirror of row.record.documents) yield* project(input.directory, row.record, mirror)
            const permit = yield* tx
              .update(GoalTickPermitTable)
              .set({
                state: "settled",
                next_seq: proof.permit.tick_seq + 1,
                next_plan_version: proof.permit.plan_version,
                outcome: "paused",
                settled_at: Date.now(),
              })
              .where(
                and(
                  eq(GoalTickPermitTable.permit_id, proof.permit.permit_id),
                  eq(GoalTickPermitTable.token, proof.permit.token),
                  eq(GoalTickPermitTable.state, source.permit.state),
                  eq(GoalTickPermitTable.owner_id, GoalControl.ownerID),
                ),
              )
              .returning({ id: GoalTickPermitTable.permit_id })
              .all()
            if (permit.length !== 1) return yield* fail("Original paused permit settlement lost its CAS")
            const goal = yield* tx
              .update(GoalControlTable)
              .set({ next_seq: proof.permit.tick_seq + 1, observed_phase: "paused", updated_at: Date.now() })
              .where(
                and(
                  eq(GoalControlTable.goal_id, row.goal_id),
                  eq(GoalControlTable.revision, proof.controlRevision),
                  eq(GoalControlTable.requested_phase, "paused"),
                  eq(GoalControlTable.next_seq, proof.permit.tick_seq),
                ),
              )
              .returning({ id: GoalControlTable.goal_id })
              .all()
            if (goal.length !== 1) return yield* fail("Goal pause cursor changed before settlement")
            const checkpoint = yield* tx
              .update(GoalTickCheckpointTable)
              .set({
                state: "halted",
                revision: source.checkpoint.revision + 1,
                error_code: "GOAL_PAUSED_BEFORE_DISPATCH",
                updated_at: Date.now(),
              })
              .where(
                and(
                  eq(GoalTickCheckpointTable.permit_id, row.permit_id),
                  eq(GoalTickCheckpointTable.revision, row.record.checkpointRevision),
                  eq(GoalTickCheckpointTable.journal_hash, row.record.checkpointHash),
                ),
              )
              .returning({ id: GoalTickCheckpointTable.permit_id })
              .all()
            if (checkpoint.length !== 1) return yield* fail("Paused checkpoint changed before settlement")
            const settled = yield* tx
              .update(GoalPauseBoundaryTable)
              .set({ state: "committed", updated_at: Date.now() })
              .where(
                and(
                  eq(GoalPauseBoundaryTable.permit_id, row.permit_id),
                  eq(GoalPauseBoundaryTable.state, "prepared"),
                  eq(GoalPauseBoundaryTable.record_hash, row.record_hash),
                ),
              )
              .returning()
              .get()
            if (!settled) return yield* fail("Goal pause receipt settlement lost its CAS")
            return settled
          }),
        { behavior: "immediate" },
      )
    }).pipe(
      GoalChildResult.withRuntimeIdentity(db),
      Effect.catch((error) =>
        error instanceof GoalControlSchema.Error
          ? Effect.fail(error)
          : fail("Goal pause evidence could not be reconciled"),
      ),
      Effect.catchDefect(() => fail("Goal pause evidence could not be safely decoded")),
    )
}

/** Structural receipt consistency only; this does not audit execution history or authorize control. */
export function matchesCommittedBaseline(
  goal: GoalControl.Row,
  permit: GoalControl.Permit,
  row: Row | undefined,
  checkpoint: GoalTickCheckpointV2.Row | undefined,
): row is Row {
  return !(
      !row ||
      row.state !== "committed" ||
      permit.state !== "settled" ||
      permit.outcome !== "paused" ||
      row.record.permitHash !== permitHash(permit) ||
      row.goal_id !== goal.goal_id ||
      row.record.sessionID !== goal.session_id ||
      row.record.initializationHash !== goal.initialization_hash ||
      permit.next_seq !== row.record.tickSeq + 1 ||
      !checkpoint ||
      checkpoint.state !== "halted" ||
      checkpoint.revision !== row.record.checkpointRevision + 1 ||
      checkpoint.journal_hash !== row.record.checkpointHash ||
      row.record.documents.some((item) => item.state !== "confirmed") ||
      checkpoint.journal.program.documents.length !== row.record.documents.length ||
      checkpoint.journal.program.documents.some(
        (item) => !row.record.documents.some((document) => document.documentID === item.id),
      )
  )
}

/** A committed pause is an explicit alternate baseline, never an arbitrary halted checkpoint. */
export const baseline = (db: Reader, goal: GoalControl.Row, permit: GoalControl.Permit) =>
  Effect.gen(function* () {
    const row = yield* read(db, permit.permit_id)
    const checkpoint = yield* GoalTickCheckpointV2.read(db, permit.permit_id)
    if (!checkpoint || !matchesCommittedBaseline(goal, permit, row, checkpoint))
      return yield* fail("Goal pause has no exact committed safe boundary")
    if (
      (yield* neverDispatched(db, checkpoint)).hash !== row.record.factsHash ||
      checkpoint.journal.program.documents.length !== row.record.documents.length ||
      checkpoint.journal.program.documents.some(
        (item) => !row.record.documents.some((document) => document.documentID === item.id),
      )
    )
      return yield* fail("Committed Goal pause source set changed")
    return {
      documents: row.record.documents,
      receiptHash: row.record_hash,
      planRevision: row.record.planRevision,
      planRebaseID: row.record.planRebaseID,
    }
  })

function requirePause(db: Reader, proof: Quiescence) {
  return Effect.gen(function* () {
    const goal = yield* GoalControl.get(db, proof.permit.goal_id)
    if (!goal) return yield* fail("Original paused Goal disappeared")
    yield* GoalControl.requireTarget(db, goal.goal_id, goal.session_id)
    const command = yield* db
      .select()
      .from(GoalControlCommandTable)
      .where(eq(GoalControlCommandTable.command_id, proof.commandID))
      .get()
    const permit = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(eq(GoalTickPermitTable.permit_id, proof.permit.permit_id))
      .get()
    const checkpoint = yield* GoalTickCheckpointV2.read(db, proof.permit.permit_id)
    if (
      !permit ||
      permitHash(permit) !== permitHash(proof.permit) ||
      permit.owner_id !== GoalControl.ownerID ||
      !["issued", "unknown"].includes(permit.state) ||
      goal.requested_phase !== "paused" ||
      goal.revision !== proof.controlRevision ||
      goal.revision !== permit.control_revision + 1 ||
      goal.next_seq !== permit.tick_seq ||
      goal.plan_version !== permit.plan_version ||
      goal.pending_rebase_id ||
      goal.recovery_reason ||
      goal.initialization.executionContract !== "owned-goal-v2" ||
      command?.action !== "pause" ||
      command.goal_id !== goal.goal_id ||
      command.session_id !== goal.session_id ||
      command.revision !== goal.revision ||
      !checkpoint ||
      !["prepared", "running", "recovery_required"].includes(checkpoint.state)
    )
      return yield* fail("Pause revision, original permit or checkpoint is no longer current")
    yield* GoalTickCheckpoint.requireParentSourceFacts(db, checkpoint)
    return { goal, permit, checkpoint }
  })
}

/** Absence is used only after the Host has joined the exact original drains, and relies on the
 * canonical runner's durable receipt-before-stream/admission-before-tool ordering invariant. */
function neverDispatched(db: Reader, checkpoint: GoalTickCheckpointV2.Row, proof?: Quiescence) {
  return Effect.gen(function* () {
    if (
      checkpoint.journal.results.length ||
      checkpoint.journal.localEffects.length ||
      checkpoint.journal.documents.length ||
      checkpoint.journal.nextState !== null ||
      checkpoint.journal.dispositions.some((item) => item.kind === "completed")
    )
      return yield* fail("Paused tick has already executed business effects or prepared a business projection")
    const permit = yield* db
      .select()
      .from(GoalTickPermitTable)
      .where(eq(GoalTickPermitTable.permit_id, checkpoint.permit_id))
      .get()
    if (!permit || permit.goal_id !== checkpoint.goal_id || permit.tick_seq !== checkpoint.tick_seq)
      return yield* fail("Paused Goal original permit disappeared")
    const size = yield* db.get<{ count: number; bytes: number }>(
      sql`SELECT count(*) AS count,coalesce(sum(length(CAST(binding AS BLOB))+length(CAST(inputs AS BLOB))),0) AS bytes FROM goal_child_unit WHERE permit_id=${checkpoint.permit_id}`,
    )
    if (!size || size.count > 64 || size.bytes > 67108864)
      return yield* fail("Paused Goal child evidence exceeds its bounded inspection")
    const units = yield* db
      .select()
      .from(GoalChildUnitTable)
      .where(eq(GoalChildUnitTable.permit_id, checkpoint.permit_id))
      .all()
    const inspected = { bytes: size.bytes }
    const facts: unknown[] = []
    for (const activation of checkpoint.journal.activations) {
      if (units.some((unit) => unit.unit_id === activation.unitID)) continue
      const role = checkpoint.journal.program.roles[activation.role]
      const id = `ses_goalchild_${GoalControl.fingerprint([checkpoint.permit_id, role.key]).slice(0, 40)}`
      if (
        yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
          .get()
      )
        return yield* fail("Paused activation has an unbound child Session")
    }
    for (const candidate of units) {
      const unit = yield* GoalChild.read(db, candidate.unit_id)
      if (
        !unit ||
        unit.binding.version === 1 ||
        unit.goal_id !== checkpoint.goal_id ||
        unit.binding.permitToken !== permit.token ||
        unit.parent_session_id !== checkpoint.journal.parent.sessionID ||
        !checkpoint.journal.activations.some((item) => item.unitID === unit.unit_id)
      )
        return yield* fail("Paused Goal child differs from its complete original stage set")
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(unit.child_session_id)))
        .get()
      if (
        (!session && (unit.creation_receipt || unit.inputs.some((item) => item.admittedSeq !== null))) ||
        (session &&
          (session.parent_id !== unit.parent_session_id ||
            !session.v2_authority ||
            session.execution_claim_token !== null))
      )
        return yield* fail("Paused child lacks confirmed claim release or exact Session identity")
      const count = yield* db.get<{ effects: number; inputs: number; descendants: number }>(sql`SELECT
        (SELECT count(*) FROM session_v2_provider_turn_receipt WHERE session_id=${unit.child_session_id})+
        (SELECT count(*) FROM session_provider_attempt WHERE session_id=${unit.child_session_id})+
        (SELECT count(*) FROM session_v2_tool_effect_admission WHERE session_id=${unit.child_session_id})+
        (SELECT count(*) FROM session_v2_tool_effect WHERE session_id=${unit.child_session_id}) AS effects,
        (SELECT count(*) FROM session_input WHERE session_id=${unit.child_session_id}) AS inputs,
        (SELECT count(*) FROM session WHERE parent_id=${unit.child_session_id}) AS descendants`)
      if (
        !count ||
        count.effects !== 0 ||
        count.descendants !== 0 ||
        count.inputs !== unit.inputs.filter((item) => item.admittedSeq !== null).length
      )
        return yield* fail(
          "Paused tick has provider/tool/descendant or unbound input evidence; its result remains unknown",
        )
      const inputBytes = yield* db.get<{ bytes: number }>(
        sql`SELECT coalesce(sum(length(CAST(prompt AS BLOB))),0) AS bytes FROM session_input WHERE session_id=${unit.child_session_id}`,
      )
      if (
        !inputBytes ||
        !Number.isSafeInteger(inputBytes.bytes) ||
        inputBytes.bytes < 0 ||
        (inspected.bytes += inputBytes.bytes) > 67108864
      )
        return yield* fail("Paused Goal inbox exceeds its bounded inspection bytes")
      const activities = yield* db.all<{ activity_id: string; trigger_input_id: string }>(
        sql`SELECT activity_id,trigger_input_id FROM session_activity WHERE session_id=${unit.child_session_id} LIMIT 193`,
      )
      if (
        activities.length > unit.inputs.length ||
        activities.some((activity) => !unit.inputs.some((stage) => stage.inputID === activity.trigger_input_id))
      )
        return yield* fail("Paused child has an activity outside its original admitted stage set")
      const members = yield* db.all<{ activity_id: string; input_id: string }>(
        sql`SELECT member.activity_id,member.input_id FROM session_activity_input AS member JOIN session_activity AS activity ON activity.activity_id=member.activity_id WHERE activity.session_id=${unit.child_session_id} LIMIT 193`,
      )
      if (
        members.length !== activities.length ||
        members.some(
          (member) =>
            !activities.some(
              (activity) =>
                activity.activity_id === member.activity_id && activity.trigger_input_id === member.input_id,
            ),
        )
      )
        return yield* fail("Paused activity has missing or additional input membership")
      const inputs = []
      for (const stage of unit.inputs) {
        if (
          stage.resultRef !== null ||
          stage.resultHash !== null ||
          stage.proposal ||
          (stage.execution &&
            (stage.execution.state === "bound" ||
              stage.execution.goalOwnerID !== permit.owner_id ||
              stage.execution.controlRevision !== permit.control_revision))
        )
          return yield* fail("Paused stage has a result or an unclosed or replaced execution")
        if (
          proof &&
          stage.execution &&
          !proof.targets.some(
            (target) =>
              target.unitID === unit.unit_id &&
              target.bindingHash === unit.binding_hash &&
              target.stage === stage.stage &&
              target.inputID === stage.inputID &&
              target.admittedSeq === stage.admittedSeq,
          )
        )
          return yield* fail("A child execution was not in the original joined registry set")
        const inbox =
          stage.admittedSeq === null
            ? undefined
            : yield* db
                .select()
                .from(SessionInputTable)
                .where(eq(SessionInputTable.id, SessionMessage.ID.make(stage.inputID)))
                .get()
        if (
          stage.admittedSeq !== null &&
          (!inbox ||
            inbox.session_id !== unit.child_session_id ||
            inbox.admitted_seq !== stage.admittedSeq ||
            inbox.delivery !== stage.delivery ||
            inbox.revert_epoch !== null ||
            GoalControl.fingerprint(inbox.prompt) !== stage.promptHash)
        )
          return yield* fail("Original paused input binding changed")
        inputs.push({ stage, inbox })
      }
      facts.push({
        binding: unit.binding_hash,
        inputs,
        activities,
        members,
        session: session
          ? {
              id: session.id,
              parent: session.parent_id,
              claim: session.execution_claim_token,
              epoch: session.mutation_epoch,
            }
          : null,
      })
    }
    if (
      proof &&
      proof.targets.some(
        (target) =>
          !units.some(
            (unit) =>
              unit.unit_id === target.unitID &&
              unit.binding_hash === target.bindingHash &&
              unit.inputs.some(
                (stage) =>
                  stage.stage === target.stage &&
                  stage.inputID === target.inputID &&
                  stage.admittedSeq === target.admittedSeq,
              ),
          ),
      )
    )
      return yield* fail("Original registry contains a missing or replaced Goal input")
    return { hash: GoalTickProgram.hash(facts), stageCount: units.reduce((sum, unit) => sum + unit.inputs.length, 0) }
  })
}

function recheck(db: Reader, row: Row, source: Effect.Success<ReturnType<typeof requirePause>>, proof: Quiescence) {
  return Effect.gen(function* () {
    if (
      row.record.permitHash !== permitHash(proof.permit) ||
      row.record.controlRevision !== proof.controlRevision ||
      row.record.commandID !== proof.commandID ||
      row.record.checkpointRevision !== source.checkpoint.revision ||
      row.record.checkpointHash !== source.checkpoint.journal_hash ||
      row.record.initializationHash !== source.goal.initialization_hash ||
      (yield* neverDispatched(db, source.checkpoint, proof)).hash !== row.record.factsHash
    )
      return yield* fail("Paused Goal original evidence changed after reservation")
  })
}

function project(directory: string, record: Record, mirror: typeof GoalTickProgram.FullDocument.Type) {
  return Effect.try({
    try: () => {
      const payload = Schema.decodeUnknownSync(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(mirror.payload)
      const store = DocumentStore.openExactForCreate(
        directory,
        record.documents.map((item) => item.documentID),
      )
      const observed = store.projectExact(payload, {
        id: mirror.documentID,
        version: mirror.expectedVersion!,
        hash: `sha256:${mirror.expectedHash}`,
      })
      if (
        mirror.state === "confirmed" &&
        (mirror.observedVersion !== observed.version || mirror.observedHash !== observed.hash.slice(7))
      )
        throw fail("Confirmed Goal pause projection changed")
      return { version: observed.version, hash: observed.hash.slice(7) }
    },
    catch: () => fail("Goal pause complete document CAS could not be confirmed"),
  })
}

function update(db: Reader, row: Row, record: Record) {
  return Effect.gen(function* () {
    const bytes = Buffer.byteLength(JSON.stringify(record))
    if (bytes > row.reserved_bytes) return yield* fail("Goal pause projection exceeded its reservation")
    const changed = yield* db
      .update(GoalPauseBoundaryTable)
      .set({ record, record_hash: GoalControl.fingerprint(record), logical_bytes: bytes, updated_at: Date.now() })
      .where(
        and(
          eq(GoalPauseBoundaryTable.permit_id, row.permit_id),
          eq(GoalPauseBoundaryTable.record_hash, row.record_hash),
          eq(GoalPauseBoundaryTable.state, "prepared"),
        ),
      )
      .returning()
      .get()
    if (!changed) return yield* fail("Goal pause receipt compare-and-swap lost")
    return changed
  })
}
